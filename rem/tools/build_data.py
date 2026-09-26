#!/usr/bin/env python3
"""Build the static REM timetable data used by /rem/index.html.

Downloads the GTFS feed published by the Réseau express métropolitain (or
reads an already extracted feed) and writes compact JSON files into rem/data/.
Run daily by .github/workflows/rem-data.yml.

Usage:
    python3 rem/tools/build_data.py
    python3 rem/tools/build_data.py --gtfs-dir /path/to/extracted/feed

Only the Python standard library is needed.
"""

import argparse
import collections
import csv
import io
import json
import re
import shutil
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

FEED_URL = "https://gtfs.gpmmom.ca/gtfs/gtfs.zip"
OUT_DIR = Path(__file__).resolve().parent.parent / "data"

DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
WESTBOUND_BRANCHES = ["A2", "A3", "A4"]


# ---------------------------------------------------------------------------
# Feed loading
# ---------------------------------------------------------------------------

def download_feed(url):
    req = urllib.request.Request(url, headers={"User-Agent": "urbancycling.xyz REM timetables"})
    print(f"Downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return zipfile.ZipFile(io.BytesIO(resp.read()))


def make_reader(args):
    """Return a function name -> list of dict rows for a GTFS table."""
    if args.gtfs_dir:
        base = Path(args.gtfs_dir)

        def read(name):
            with open(base / name, encoding="utf-8-sig", newline="") as f:
                return list(csv.DictReader(f))
        return read

    zf = download_feed(args.url)
    names = {Path(n).name: n for n in zf.namelist()}

    def read(name):
        with zf.open(names[name]) as f:
            return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline="")))
    return read


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def gtfs_minutes(hms):
    """'25:03:40' -> 1503 (minutes after service-day midnight, seconds dropped)."""
    h, m, _ = hms.strip().split(":")
    return int(h) * 60 + int(m)


def gtfs_date(s):
    return date(int(s[:4]), int(s[4:6]), int(s[6:]))


def clean_station_name(name):
    return re.sub(r"^Station\s+", "", name.strip())


def branch_of(headsign):
    """'A3 - Anse-à-l'Orme' -> 'A3'; 'Bois-Franc' -> None (short turn)."""
    m = re.match(r"\s*(A\d)\b", headsign)
    return m.group(1) if m else None


def platform_of(stop):
    """'Station Kirkland quai 1' / 'STA_ZCD_BT_QUAI_01_JYV' -> '1'."""
    m = re.search(r"quai\D{0,2}(\d+)", stop["stop_name"] + " " + stop["stop_id"], re.I)
    return str(int(m.group(1))) if m else None


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build(read):
    stops = {r["stop_id"]: r for r in read("stops.txt")}
    routes = {r["route_id"]: r for r in read("routes.txt")}
    trips = {r["trip_id"]: r for r in read("trips.txt")}
    calendar = read("calendar.txt")
    try:
        calendar_dates = read("calendar_dates.txt")
    except (KeyError, FileNotFoundError):
        calendar_dates = []
    try:
        feed_info = read("feed_info.txt")[0]
    except (KeyError, FileNotFoundError, IndexError):
        feed_info = {}

    def station_of(stop_id):
        s = stops[stop_id]
        return s["parent_station"] or stop_id

    # --- stop times grouped by trip ---------------------------------------
    by_trip = collections.defaultdict(list)
    for r in read("stop_times.txt"):
        by_trip[r["trip_id"]].append(r)
    for rows in by_trip.values():
        rows.sort(key=lambda r: int(r["stop_sequence"]))

    # --- services -----------------------------------------------------------
    added = collections.defaultdict(list)
    removed = collections.defaultdict(list)
    for r in calendar_dates:
        (added if r["exception_type"] == "1" else removed)[r["service_id"]].append(r["date"])

    services = []
    for c in calendar:
        sid = c["service_id"]
        services.append({
            "id": sid,
            "days": [i for i, d in enumerate(DAY_NAMES) if c[d] == "1"],
            "start": gtfs_date(c["start_date"]).isoformat(),
            "end": gtfs_date(c["end_date"]).isoformat(),
            "added": sorted(gtfs_date(d).isoformat() for d in added[sid]),
            "removed": sorted(gtfs_date(d).isoformat() for d in removed[sid]),
        })
    services.sort(key=lambda s: (s["days"][0] if s["days"] else 9, s["start"]))
    service_ids = {s["id"] for s in services}

    # --- departures per station / direction / service -----------------------
    # deps[station][direction_key][service_id] = list of (minute, tag)
    deps = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(list)))
    branch_dest = {}          # "A3" -> "Anse-à-l'Orme"
    short_turns = {}          # tag -> terminus name, for trips without a branch
    patterns = []             # westbound station sequences, used for line ordering
    platforms = collections.defaultdict(lambda: collections.defaultdict(set))

    for trip_id, rows in by_trip.items():
        trip = trips[trip_id]
        if trip["service_id"] not in service_ids:
            continue
        headsign = trip.get("trip_headsign", "") or routes[trip["route_id"]]["route_long_name"]
        branch = branch_of(headsign)
        terminus = clean_station_name(stops[station_of(rows[-1]["stop_id"])]["stop_name"])
        if branch:
            branch_dest.setdefault(branch, terminus)
            tag = branch
        else:
            tag = "T:" + terminus
            short_turns[tag] = terminus

        seq = [station_of(r["stop_id"]) for r in rows]
        eastbound = branch == "A1"
        if not eastbound:
            patterns.append(seq)

        for r in rows[:-1]:
            if r.get("pickup_type", "0") == "1":
                continue
            st = station_of(r["stop_id"])
            minute = gtfs_minutes(r["departure_time"] or r["arrival_time"])
            keys = ["A1"] if eastbound else ([branch] if branch else []) + ["W"]
            quai = platform_of(stops[r["stop_id"]])
            for key in keys:
                deps[st][key][trip["service_id"]].append((minute, tag))
                if quai:
                    platforms[st][key].add(quai)

    # --- station ordering along the line ------------------------------------
    order = []
    for seq in sorted(patterns, key=len, reverse=True):
        for st in seq:
            if st not in order:
                order.append(st)
    for st in deps:
        if st not in order:
            order.append(st)

    # --- per-station output ---------------------------------------------------
    # Tag -> branch code (None for short trips) and terminus; labels are built by the page.
    tags = {b: {"code": b, "terminus": d} for b, d in branch_dest.items()}
    tags.update({t: {"code": None, "terminus": n} for t, n in short_turns.items()})

    stations_out = []
    station_files = {}
    for st in order:
        if st not in deps:
            continue
        s = stops[st]
        d = deps[st]
        west_branches = [b for b in WESTBOUND_BRANCHES if b in d]

        directions = []
        keys = (["A1"] if "A1" in d else []) + west_branches
        # Combined westbound view when more than one branch (or short trips) serve the station.
        west_tags = {t for svc in d.get("W", {}).values() for _, t in svc}
        if len(west_branches) > 1 or (west_branches and west_tags - set(west_branches)):
            keys.append("W")
        elif not west_branches and "W" in d:
            keys.append("W")     # only short trips go west from here

        for key in keys:
            # "W" = every westbound train; its code lists the branches, e.g. "A3/A4".
            code = "/".join(west_branches) if key == "W" else key
            dest = "" if key == "W" else branch_dest.get(key, "")
            timetable = {}
            for sid, lst in d[key].items():
                lst.sort()
                timetable[sid] = [[m, t] if key == "W" else m for m, t in lst]
            directions.append({"key": key, "code": code,
                               "destination": dest,
                               "platforms": sorted(platforms[st][key], key=int),
                               "timetable": timetable})

        fname = f"{st}.json"
        station_files[fname] = {
            "id": st,
            "name": clean_station_name(s["stop_name"]),
            "directions": directions,
        }
        stations_out.append({
            "id": st,
            "name": clean_station_name(s["stop_name"]),
            "lat": round(float(s["stop_lat"]), 6),
            "lon": round(float(s["stop_lon"]), 6),
            "directions": [x["key"] for x in directions],
        })

    # --- shapes for the map (most used shape of each route) -----------------
    shape_use = collections.defaultdict(collections.Counter)
    for t in trips.values():
        if t.get("shape_id"):
            shape_use[t["route_id"]][t["shape_id"]] += 1
    wanted = {c.most_common(1)[0][0]: rid for rid, c in shape_use.items()}
    shape_pts = collections.defaultdict(list)
    try:
        for r in read("shapes.txt"):
            if r["shape_id"] in wanted:
                shape_pts[r["shape_id"]].append((int(r["shape_pt_sequence"]),
                                                 round(float(r["shape_pt_lat"]), 5),
                                                 round(float(r["shape_pt_lon"]), 5)))
    except (KeyError, FileNotFoundError):
        pass
    lines = []
    for sid, pts in shape_pts.items():
        pts.sort()
        coords = []
        for _, la, lo in pts:
            if not coords or coords[-1] != [la, lo]:
                coords.append([la, lo])
        color = "#" + (routes[wanted[sid]].get("route_color") or "73A400")
        lines.append({"route": wanted[sid], "color": color, "coords": coords})

    network = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "feed_version": feed_info.get("feed_version", ""),
        "feed_start": gtfs_date(feed_info["feed_start_date"]).isoformat() if feed_info.get("feed_start_date") else "",
        "feed_end": gtfs_date(feed_info["feed_end_date"]).isoformat() if feed_info.get("feed_end_date") else "",
        "services": services,
        "tags": tags,
        "stations": stations_out,
        "lines": lines,
    }
    return network, station_files


def write(network, station_files):
    st_dir = OUT_DIR / "stations"
    if st_dir.exists():
        shutil.rmtree(st_dir)
    st_dir.mkdir(parents=True)
    with open(OUT_DIR / "network.json", "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, separators=(",", ":"))
    for name, data in station_files.items():
        with open(st_dir / name, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(station_files)} stations to {OUT_DIR}", file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--gtfs-dir", help="Use an already extracted GTFS feed instead of downloading it")
    p.add_argument("--url", default=FEED_URL, help="GTFS zip to download (default: %(default)s)")
    args = p.parse_args()
    write(*build(make_reader(args)))


if __name__ == "__main__":
    main()
