// REM timetables: map + static timetables built by tools/build_data.py.
// Text follows the site language (/lang.js), in English or French.
(function () {
  "use strict";

  // Regular (non-folding) bikes are not allowed on board during weekday rush hours.
  // https://rem.info/fr/se-deplacer/faq-sur-les-deplacements/est-ce-que-je-peux-transporter-mon-velo-dans-le-rem
  var BIKE_BAN = {
    days: [0, 1, 2, 3, 4], // Monday to Friday
    windows: [
      [7 * 60, 9 * 60 + 30],
      [15 * 60 + 30, 18 * 60],
    ],
  };

  var TEXT = {
    en: {
      months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      weekdays: "Weekdays",
      holidays: " & holidays",
      choose: "— choose a station —",
      towards: "→",
      combined: "{code} combined → all westbound trains",
      shortTrips: "{code} + short trips → westbound",
      shortTrip: "Short trip to {name}",
      valid: "Valid {from} to {to}.",
      notRunning: "Not running on {dates}.",
      alsoRuns: "Also runs on {dates}.",
      noDepartures: "No departures.",
      legend: "Legend: ",
      listSep: "; ",
      noBikes: "Regular bikes not allowed",
      bikeNote: "Underlined times: regular (non-folding) bikes are not allowed on board (weekdays 7:00–9:30 and 15:30–18:00).",
      bikeRules: "REM bike rules",
      source:
        "Schedule data: Réseau express métropolitain {feed} (version {version}), {licence}, last checked {checked}. Times are scheduled departures and may change; check {rem} before travelling.",
      feed: "GTFS feed",
      loadError: "Could not load REM data ({error}).",
      hour: "Hour",
      sheetTo: "Departures to {dest} ({code})",
      sheetWest: "All westbound departures ({code})",
      platform: "platform",
      platforms: "platforms",
      and: " & ",
      fromFeed: "Scheduled timetable from the REM GTFS data ({details}).",
      versionOf: "version of {date}",
      validUntil: "valid until {date}",
      scheduleOn: "{dates}: {schedule}.",
      noService: "No service on {dates}.",
      freqNote: "» = trains every 4 minutes or less between the two times shown.",
      fileTo: "to",
      fileWest: "westbound",
    },
    fr: {
      months: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
      days: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
      weekdays: "Lundi au vendredi",
      holidays: " et fériés",
      choose: "— choisir une station —",
      towards: "→",
      combined: "{code} combinés → tous les trains vers l'ouest",
      shortTrips: "{code} + trajets courts → vers l'ouest",
      shortTrip: "Trajet court jusqu'à {name}",
      valid: "Valide du {from} au {to}.",
      notRunning: "Ne s'applique pas le {dates}.",
      alsoRuns: "S'applique aussi le {dates}.",
      noDepartures: "Aucun départ.",
      legend: "Légende : ",
      listSep: " ; ",
      noBikes: "Vélos non pliants interdits",
      bikeNote: "Heures soulignées : vélos non pliants interdits à bord (en semaine de 7 h à 9 h 30 et de 15 h 30 à 18 h).",
      bikeRules: "règles du REM pour les vélos",
      source:
        "Données d'horaire : {feed} du Réseau express métropolitain (version {version}), {licence}, dernière vérification le {checked}. Les heures sont des départs planifiés et peuvent changer; consultez {rem} avant de partir.",
      feed: "flux GTFS",
      loadError: "Impossible de charger les données du REM ({error}).",
      hour: "Heure",
      sheetTo: "Départs vers {dest} ({code})",
      sheetWest: "Tous les départs vers l'ouest ({code})",
      platform: "quai",
      platforms: "quais",
      and: " et ",
      fromFeed: "Horaire planifié tiré des données GTFS du REM ({details}).",
      versionOf: "version du {date}",
      validUntil: "valide jusqu'au {date}",
      scheduleOn: "{dates} : {schedule}.",
      noService: "Aucun service le {dates}.",
      freqNote: "» : départs aux 4 minutes ou moins entre les deux heures indiquées.",
      fileTo: "vers",
      fileWest: "ouest",
    },
  };

  var network = null;
  var stationCache = {};
  var markers = {};
  var state = { station: null, dir: null, svc: null };
  var map;

  // ------------------------------------------------------------------
  // Language
  // ------------------------------------------------------------------

  function lang() {
    return window.siteLang && window.siteLang.get() === "fr" ? "fr" : "en";
  }

  // t("valid", { from: "...", to: "..." })
  function t(key, values) {
    var s = TEXT[lang()][key];
    return typeof s === "string" && values
      ? s.replace(/\{(\w+)\}/g, function (m, k) { return k in values ? values[k] : m; })
      : s;
  }

  // Appends a template to el, replacing {tokens} with the given nodes or strings.
  function fill(el, template, parts) {
    template.split(/(\{\w+\})/).forEach(function (piece) {
      var m = /^\{(\w+)\}$/.exec(piece);
      var part = m && m[1] in parts ? parts[m[1]] : piece;
      el.appendChild(typeof part === "string" ? document.createTextNode(part) : part);
    });
  }

  function link(href, text) {
    var a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    return a;
  }

  function bold(text) {
    var b = document.createElement("b");
    b.textContent = text;
    return b;
  }

  // ------------------------------------------------------------------
  // Dates
  // ------------------------------------------------------------------

  function todayMontreal() {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Montreal" }).format(new Date());
  }

  function hourMontreal() {
    return parseInt(
      new Intl.DateTimeFormat("en-GB", { timeZone: "America/Montreal", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
      10
    );
  }

  function dayIndex(iso) {
    // Monday = 0 ... Sunday = 6, like GTFS calendar columns
    return (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7;
  }

  // "Jun 24" / "24 juin", "1er juillet"
  function prettyDate(iso) {
    var p = iso.split("-");
    var month = t("months")[parseInt(p[1], 10) - 1];
    var day = parseInt(p[2], 10);
    if (lang() === "fr") return (day === 1 ? "1er" : day) + " " + month;
    return month.slice(0, 3) + " " + day;
  }

  function prettyDateYear(iso) {
    return prettyDate(iso) + (lang() === "fr" ? " " : ", ") + iso.slice(0, 4);
  }

  function dateList(dates) {
    return dates.map(prettyDate).join(", ");
  }

  function serviceRunsOn(svc, iso) {
    if (svc.added.indexOf(iso) >= 0) return true;
    if (svc.removed.indexOf(iso) >= 0) return false;
    return iso >= svc.start && iso <= svc.end && svc.days.indexOf(dayIndex(iso)) >= 0;
  }

  function todaysService() {
    var today = todayMontreal();
    for (var i = 0; i < network.services.length; i++) {
      if (serviceRunsOn(network.services[i], today)) return network.services[i].id;
    }
    var dow = dayIndex(today);
    for (i = 0; i < network.services.length; i++) {
      if (network.services[i].days.indexOf(dow) >= 0) return network.services[i].id;
    }
    return network.services.length ? network.services[0].id : null;
  }

  function serviceById(id) {
    for (var i = 0; i < network.services.length; i++) {
      if (network.services[i].id === id) return network.services[i];
    }
    return null;
  }

  function isWeekdays(days) {
    return days.join() === "0,1,2,3,4";
  }

  // "Weekdays", "Saturday", "Monday–Thursday" ...
  function serviceLabel(svc) {
    var names = t("days");
    var d = svc.days;
    if (isWeekdays(d)) return t("weekdays");
    if (d.length > 2 && d[d.length - 1] - d[0] === d.length - 1) return names[d[0]] + "–" + names[d[d.length - 1]].toLowerCase();
    return d.map(function (i, n) { return n ? names[i].toLowerCase() : names[i]; }).join(t("and"));
  }

  // "Sunday schedule" / "horaire du dimanche"
  function scheduleName(svc) {
    if (lang() === "en") return serviceLabel(svc) + " schedule";
    if (isWeekdays(svc.days)) return "horaire de semaine";
    if (svc.days.length === 1) return "horaire du " + t("days")[svc.days[0]].toLowerCase();
    return "horaire « " + serviceLabel(svc) + " »";
  }

  // A service that also runs on days removed from another one covers holidays.
  function coversHolidays(svc) {
    return network.services.some(function (other) {
      return other !== svc && svc.added.some(function (d) { return other.removed.indexOf(d) >= 0; });
    });
  }

  // True when regular bikes are not allowed on a departure of this service.
  function bikeBanned(svc, minute) {
    if (!svc || !svc.days.length) return false;
    var allBanDays = svc.days.every(function (d) { return BIKE_BAN.days.indexOf(d) >= 0; });
    return allBanDays && BIKE_BAN.windows.some(function (w) { return minute >= w[0] && minute <= w[1]; });
  }

  function bikeRulesUrl() {
    return lang() === "fr"
      ? "https://rem.info/fr/se-deplacer/faq-sur-les-deplacements/est-ce-que-je-peux-transporter-mon-velo-dans-le-rem"
      : "https://rem.info/en/travelling/travel-faq/can-I-bring-my-bike-in-the-rem";
  }

  // ------------------------------------------------------------------
  // URL hash: #station=ST_JYV_1&dir=A3&svc=...
  // ------------------------------------------------------------------

  function readHash() {
    var out = {};
    location.hash.replace(/^#/, "").split("&").forEach(function (part) {
      var kv = part.split("=");
      if (kv[0]) out[kv[0]] = decodeURIComponent(kv[1] || "");
    });
    return out;
  }

  function writeHash() {
    if (!state.station) return;
    var h = "#station=" + encodeURIComponent(state.station);
    if (state.dir) h += "&dir=" + encodeURIComponent(state.dir);
    if (state.svc) h += "&svc=" + encodeURIComponent(state.svc);
    history.replaceState(null, "", h);
  }

  // ------------------------------------------------------------------
  // Map
  // ------------------------------------------------------------------

  function buildMap() {
    map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    network.lines.forEach(function (line) {
      L.polyline(line.coords, { color: line.color, weight: 5, opacity: 0.85 }).addTo(map);
    });

    var bounds = [];
    network.stations.forEach(function (st) {
      var m = L.circleMarker([st.lat, st.lon], {
        radius: 7,
        color: "#3d5a00",
        weight: 2,
        fillColor: "#fff",
        fillOpacity: 1,
      }).addTo(map);
      m.on("click", function () {
        selectStation(st.id, true);
      });
      markers[st.id] = { marker: m, name: st.name };
      bounds.push([st.lat, st.lon]);
    });
    map.fitBounds(bounds, { padding: [20, 20] });
    updateLabels();
    map.on("zoomend", updateLabels);
  }

  // Station names are always shown when zoomed in, on hover otherwise.
  function updateLabels() {
    var permanent = map.getZoom() >= 12;
    Object.keys(markers).forEach(function (id) {
      var m = markers[id].marker;
      m.unbindTooltip();
      m.bindTooltip(markers[id].name, {
        permanent: permanent,
        direction: "right",
        offset: [6, 0],
        className: permanent ? "station-label" : "",
      });
    });
  }

  function highlightMarker() {
    Object.keys(markers).forEach(function (id) {
      var sel = id === state.station;
      markers[id].marker.setStyle({ fillColor: sel ? "#73a400" : "#fff", radius: sel ? 9 : 7 });
      if (sel) markers[id].marker.bringToFront();
    });
  }

  // ------------------------------------------------------------------
  // Panel
  // ------------------------------------------------------------------

  function loadStation(id) {
    if (stationCache[id]) return Promise.resolve(stationCache[id]);
    return fetch("data/stations/" + encodeURIComponent(id) + ".json")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        stationCache[id] = data;
        return data;
      });
  }

  function selectStation(id, scroll) {
    state.station = id;
    document.getElementById("station-select").value = id;
    highlightMarker();
    return loadStation(id).then(function (data) {
      var keys = data.directions.map(function (d) { return d.key; });
      if (keys.indexOf(state.dir) < 0) state.dir = keys[0];
      render(data);
      if (scroll) document.getElementById("panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function makeButton(label, pressed, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-pressed", pressed ? "true" : "false");
    b.addEventListener("click", onClick);
    return b;
  }

  function directionText(d) {
    if (d.key !== "W") return d.code + " " + t("towards") + " " + d.destination;
    return t(d.code.indexOf("/") >= 0 ? "combined" : "shortTrips", { code: d.code });
  }

  function currentDirection(data) {
    return data.directions.filter(function (d) { return d.key === state.dir; })[0];
  }

  function render(data) {
    var panel = document.getElementById("panel");
    panel.hidden = false;
    document.getElementById("station-name").textContent = data.name;

    // Directions
    var dirBox = document.getElementById("directions");
    dirBox.innerHTML = "";
    data.directions.forEach(function (d) {
      dirBox.appendChild(
        makeButton(directionText(d), d.key === state.dir, function () {
          state.dir = d.key;
          render(data);
        })
      );
    });
    var dir = currentDirection(data);

    // Service days available for this direction
    var svcBox = document.getElementById("services");
    svcBox.innerHTML = "";
    var available = network.services.filter(function (s) { return dir.timetable[s.id]; });
    var ids = available.map(function (s) { return s.id; });
    if (ids.indexOf(state.svc) < 0) {
      var today = todaysService();
      state.svc = ids.indexOf(today) >= 0 ? today : ids[0];
    }
    available.forEach(function (s) {
      svcBox.appendChild(
        makeButton(serviceLabel(s), s.id === state.svc, function () {
          state.svc = s.id;
          render(data);
        })
      );
    });

    renderNotes(serviceById(state.svc));
    renderTable(dir, state.svc);
    writeHash();
  }

  function renderNotes(svc) {
    var el = document.getElementById("service-notes");
    if (!svc) {
      el.textContent = "";
      return;
    }
    var parts = [t("valid", { from: prettyDateYear(svc.start), to: prettyDateYear(svc.end) })];
    if (svc.removed.length) parts.push(t("notRunning", { dates: dateList(svc.removed) }));
    if (svc.added.length) parts.push(t("alsoRuns", { dates: dateList(svc.added) }));
    el.textContent = parts.join(" ");
  }

  function tagMark(tag) {
    // "A3" -> "3", "T:Bois-Franc" -> "BF"
    if (/^A\d$/.test(tag)) return { text: tag.slice(1), cls: "" };
    var name = tag.replace(/^T:/, "");
    var initials = name.split(/[\s\-']+/).map(function (w) { return w.charAt(0).toUpperCase(); }).join("");
    return { text: initials, cls: "short" };
  }

  function tagName(tag) {
    var info = network.tags[tag];
    if (!info) return tag;
    return info.code ? info.code + " – " + info.terminus : t("shortTrip", { name: info.terminus });
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // "06" / "6 h" (hours >= 24 are after midnight)
  function hourLabel(h) {
    return lang() === "fr" ? (h % 24) + " h" : pad(h % 24);
  }

  // Departures of one service grouped by hour of the service day (hours >= 24
  // are after midnight): { hours: [6, 7, ...], byHour: { 6: [[min, tag, banned, minuteOfDay], ...] } }
  function groupByHour(dir, svcId) {
    var combined = dir.key === "W";
    var svc = serviceById(svcId);
    var hours = [];
    var byHour = {};
    (dir.timetable[svcId] || []).forEach(function (entry) {
      var min = combined ? entry[0] : entry;
      var h = Math.floor(min / 60);
      if (!byHour[h]) {
        byHour[h] = [];
        hours.push(h);
      }
      byHour[h].push([min % 60, combined ? entry[1] : null, bikeBanned(svc, min), min]);
    });
    return { hours: hours, byHour: byHour };
  }

  // "07" with its branch mark for combined views, underlined when regular
  // bikes are not allowed; or the » of a frequent-service run on the sheet.
  // Records what was used in `used`.
  function minuteSpan(m, used) {
    var span = document.createElement("span");
    if (m.freq) {
      span.textContent = "»";
      span.className = "freq" + (m.banned ? " no-bike" : "");
      used.freq = true;
      if (m.banned) used.noBike = true;
      return span;
    }
    var digits = document.createElement("span");
    digits.textContent = pad(m[0]);
    if (m[2]) {
      digits.className = "no-bike";
      digits.title = t("noBikes");
      used.noBike = true;
    }
    span.appendChild(digits);
    if (m[1]) {
      var mark = tagMark(m[1]);
      var sup = document.createElement("sup");
      sup.textContent = mark.text;
      if (mark.cls) sup.className = mark.cls;
      span.appendChild(sup);
      used.tags[m[1]] = mark;
    }
    return span;
  }

  function legendText(used) {
    var tags = Object.keys(used.tags).sort();
    return tags.length
      ? t("legend") + tags.map(function (tag) { return used.tags[tag].text + " = " + tagName(tag); }).join(t("listSep")) + "."
      : "";
  }

  function renderTable(dir, svcId) {
    var tbody = document.querySelector("#timetable tbody");
    tbody.innerHTML = "";
    var g = groupByHour(dir, svcId);
    var highlight = svcId === todaysService() ? hourMontreal() : -1;
    var used = { tags: {}, noBike: false };
    g.hours.forEach(function (h) {
      var tr = document.createElement("tr");
      if (h === highlight) tr.className = "now";
      var th = document.createElement("td");
      th.className = "hour";
      th.textContent = hourLabel(h);
      var td = document.createElement("td");
      td.className = "minutes";
      g.byHour[h].forEach(function (m) {
        td.appendChild(minuteSpan(m, used));
      });
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    if (!g.hours.length) {
      var row = tbody.insertRow();
      var cell = row.insertCell();
      cell.colSpan = 2;
      cell.textContent = t("noDepartures");
    }

    var legend = document.getElementById("legend");
    legend.innerHTML = "";
    var text = legendText(used);
    if (text) legend.appendChild(document.createTextNode(text + " "));
    if (used.noBike) {
      legend.appendChild(document.createTextNode(t("bikeNote") + " ("));
      legend.appendChild(link(bikeRulesUrl(), t("bikeRules")));
      legend.appendChild(document.createTextNode(")"));
    }
  }

  // ------------------------------------------------------------------
  // PDF export: a one-page weekly sheet printed through the browser
  // ------------------------------------------------------------------

  function slug(text) {
    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  // On the sheet, a run of FREQUENT.min or more departures at most FREQUENT.gap
  // minutes apart shows as "first » last". Runs break at each hour, so every
  // row shows its own first and last departure, and where the bike rule changes
  // (7:00, 9:30, 15:30, 18:00), so each one is either fully underlined or not.
  var FREQUENT = { gap: 4, min: 4 };

  function compressFrequent(g) {
    var byHour = {};
    g.hours.forEach(function (h) {
      var deps = g.byHour[h];
      var out = (byHour[h] = []);
      for (var i = 0; i < deps.length; ) {
        var j = i;
        while (j + 1 < deps.length && deps[j + 1][3] - deps[j][3] <= FREQUENT.gap && deps[j + 1][2] === deps[i][2]) j++;
        if (j - i + 1 < FREQUENT.min) {
          out.push(deps[i]);
          i++;
          continue;
        }
        out.push(deps[i], { freq: true, banned: deps[i][2] }, deps[j]);
        i = j + 1;
      }
    });
    return { hours: g.hours, byHour: byHour };
  }

  // Printable area inside the 1.5 cm margins, in CSS pixels: the width of A4 and
  // the height of Letter, whichever is smaller, so the sheet fits on either.
  var PAGE = { width: 680, height: 940 };

  // Shrinks the sheet (CSS zoom) when it would not fit on one page. Zooming out
  // also gives the table more room, so rows wrap less: search for the largest
  // zoom that fits instead of scaling by the height ratio.
  function fitSheet(sheet) {
    sheet.style.cssText = "display: block; position: absolute; left: -10000px; top: 0";
    var fits = function (zoom) {
      sheet.style.zoom = zoom;
      sheet.style.width = PAGE.width / zoom + "px"; // the page width, in zoomed units
      return sheet.getBoundingClientRect().height <= PAGE.height;
    };
    var zoom = 1;
    if (!fits(1)) {
      var lo = 0.2;
      var hi = 1;
      for (var i = 0; i < 10; i++) {
        var mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      zoom = lo;
    }
    sheet.style.cssText = "";
    if (zoom < 1) sheet.style.zoom = zoom.toFixed(3);
  }

  function sheetFootnote(services, used) {
    var parts = [];
    var v = network.feed_version;
    var details = [];
    if (/^\d{8}$/.test(v)) details.push(t("versionOf", { date: prettyDateYear(v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6)) }));
    else if (v) details.push("version " + v);
    if (network.feed_end) details.push(t("validUntil", { date: prettyDateYear(network.feed_end) }));
    parts.push(t("fromFeed", { details: details.join(", ") }).replace(" ().", "."));

    var added = [];
    services.forEach(function (s) {
      if (s.added.length) parts.push(t("scheduleOn", { dates: dateList(s.added), schedule: scheduleName(s) }));
      added = added.concat(s.added);
    });
    services.forEach(function (s) {
      var none = s.removed.filter(function (d) { return added.indexOf(d) < 0; });
      if (none.length) parts.push(t("noService", { dates: dateList(none) }));
    });
    if (used.freq) parts.push(t("freqNote"));
    if (used.noBike) parts.push(t("bikeNote"));
    var legend = legendText(used);
    if (legend) parts.push(legend);
    return parts.join(" ");
  }

  function buildSheet(data, dir) {
    var sheet = document.getElementById("print-sheet");
    sheet.innerHTML = "";

    var h1 = document.createElement("h1");
    h1.textContent = "REM — Station " + data.name;
    sheet.appendChild(h1);

    var sub = document.createElement("p");
    sub.className = "subtitle";
    if (dir.key === "W") fill(sub, t("sheetWest"), { code: bold(dir.code) });
    else fill(sub, t("sheetTo"), { dest: bold(dir.destination), code: dir.code });
    var plat = dir.platforms || [];
    if (plat.length) sub.appendChild(document.createTextNode(" · " + t(plat.length > 1 ? "platforms" : "platform") + " " + plat.join(t("and"))));
    sheet.appendChild(sub);

    var services = network.services.filter(function (s) { return dir.timetable[s.id]; });
    var groups = services.map(function (s) { return compressFrequent(groupByHour(dir, s.id)); });
    var hours = [];
    groups.forEach(function (g) {
      g.hours.forEach(function (h) {
        if (hours.indexOf(h) < 0) hours.push(h);
      });
    });
    hours.sort(function (a, c) { return a - c; });

    var table = document.createElement("table");
    // Give each service column room in proportion to its busiest hour.
    var busiest = groups.map(function (g) {
      return Math.max.apply(null, [4].concat(g.hours.map(function (h) { return g.byHour[h].length; })));
    });
    var total = busiest.reduce(function (a, c) { return a + c; }, 0);
    var colgroup = document.createElement("colgroup");
    colgroup.appendChild(document.createElement("col")).className = "hour-col";
    busiest.forEach(function (n) {
      colgroup.appendChild(document.createElement("col")).style.width = (100 * n / total).toFixed(1) + "%";
    });
    table.appendChild(colgroup);
    var head = document.createElement("tr");
    [t("hour")].concat(services.map(function (s) { return serviceLabel(s) + (coversHolidays(s) ? t("holidays") : ""); })).forEach(function (text) {
      var th = document.createElement("th");
      th.textContent = text;
      head.appendChild(th);
    });
    var thead = document.createElement("thead");
    thead.appendChild(head);
    table.appendChild(thead);

    var used = { tags: {}, noBike: false, freq: false };
    var tbody = document.createElement("tbody");
    hours.forEach(function (h) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.className = "hour";
      td.textContent = hourLabel(h);
      tr.appendChild(td);
      groups.forEach(function (g) {
        var cell = document.createElement("td");
        cell.className = "minutes";
        var box = document.createElement("div");
        // No branch or short-trip marks on the sheet: it stays easier to read.
        (g.byHour[h] || []).forEach(function (m) {
          box.appendChild(minuteSpan(m.freq ? m : [m[0], null, m[2], m[3]], used));
        });
        cell.appendChild(box);
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    sheet.appendChild(table);

    var note = document.createElement("p");
    note.className = "footnote";
    note.textContent = sheetFootnote(services, used);
    sheet.appendChild(note);
    fitSheet(sheet);

    return "REM_" + slug(data.name) + "_" + (dir.key === "W" ? t("fileWest") + "_" + slug(dir.code) : t("fileTo") + "_" + slug(dir.destination));
  }

  function exportPdf() {
    var data = stationCache[state.station];
    if (!data) return;
    var dir = currentDirection(data);
    if (!dir) return;

    // The document title becomes the suggested PDF file name.
    var title = document.title;
    document.title = buildSheet(data, dir);
    document.body.classList.add("print-sheet");
    var restore = function () {
      document.body.classList.remove("print-sheet");
      document.title = title;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------

  function renderSource() {
    var el = document.getElementById("source");
    el.innerHTML = "";
    fill(el, t("source"), {
      feed: link("https://gtfs.gpmmom.ca/gtfs/gtfs.zip", t("feed")),
      version: network.feed_version || "?",
      licence: link("https://www.donneesquebec.ca/licence/#cc-by", "CC BY 4.0"),
      checked: network.generated ? prettyDateYear(network.generated) : "?",
      rem: link("https://rem.info/" + lang(), "rem.info"),
    });
  }

  function renderLanguage() {
    document.querySelector('#station-select option[value=""]').textContent = t("choose");
    renderSource();
    if (state.station && stationCache[state.station]) render(stationCache[state.station]);
  }

  function init() {
    fetch("data/network.json")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        network = data;
        var select = document.getElementById("station-select");
        network.stations.forEach(function (st) {
          var o = document.createElement("option");
          o.value = st.id;
          o.textContent = st.name;
          select.appendChild(o);
        });
        select.addEventListener("change", function () {
          if (select.value) selectStation(select.value, false);
        });
        document.getElementById("export-pdf").addEventListener("click", exportPdf);
        document.addEventListener("langchange", renderLanguage);
        buildMap();
        renderLanguage();

        var h = readHash();
        if (h.station && markers[h.station]) {
          state.dir = h.dir || null;
          state.svc = h.svc || null;
          selectStation(h.station, false);
        }
      })
      .catch(function (err) {
        document.getElementById("map").textContent = t("loadError", { error: err.message });
      });
  }

  init();
})();
