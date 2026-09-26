// Site language (en/fr). Pages carry both languages in elements marked
// lang="en" / lang="fr"; this script hides the other one. The choice comes
// from the selector in the header (saved in the browser), otherwise from the
// browser language. Load it in <head>, before the body renders.
//
// Page titles come from <html data-title-en="..." data-title-fr="...">.
// Scripts can call siteLang.get() and listen to the "langchange" event.
(function () {
  "use strict";

  var SITE = { en: "Urban Cycling MTL", fr: "Vélo Urbain MTL" };
  var KEY = "lang";
  var root = document.documentElement;

  var stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch (e) {}
  var lang = stored === "en" || stored === "fr" ? stored : /^fr\b/i.test(navigator.language || "") ? "fr" : "en";

  var style = document.createElement("style");
  style.textContent =
    'html[lang="en"] body [lang="fr"], html[lang="fr"] body [lang="en"] { display: none !important; }' +
    'html[lang="en"] [data-set-lang="en"], html[lang="fr"] [data-set-lang="fr"] {' +
    " font-weight: bold; color: inherit; text-decoration: none; pointer-events: none; }";
  document.head.appendChild(style);

  function apply() {
    root.lang = lang;
    var page = root.getAttribute("data-title-" + lang);
    document.title = page ? page + " – " + SITE[lang] : SITE[lang];
  }

  function set(value) {
    if (value !== "en" && value !== "fr" || value === lang) return;
    lang = value;
    try {
      localStorage.setItem(KEY, lang);
    } catch (e) {}
    apply();
    document.dispatchEvent(new CustomEvent("langchange", { detail: lang }));
  }

  // The selector lives in the header, which is loaded after this script runs.
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("[data-set-lang]");
    if (!link) return;
    e.preventDefault();
    set(link.getAttribute("data-set-lang"));
  });

  window.siteLang = {
    get: function () {
      return lang;
    },
    set: set,
  };

  apply();
})();
