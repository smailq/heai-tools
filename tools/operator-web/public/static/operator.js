// Keeps the page current and filterable without leaving it: every few seconds the
// same URL is read again and the live region swapped - on the architect tab, whose
// editor holds unsaved work, only the tabs above it - and the filter box hides the
// rows that do not contain its text. Nothing here sends anything but a GET.
(function () {
  "use strict";
  var every = Math.max(1, parseInt(document.body.dataset.refresh, 10) || 2) * 1000;
  var needle = "";

  function applyFilter() {
    document.querySelectorAll(".filter").forEach(function (box) {
      if (box.value !== needle) box.value = needle;
    });
    var n = needle.toLowerCase();
    document.querySelectorAll("table.grid tbody tr").forEach(function (tr) {
      tr.hidden = n !== "" && tr.textContent.toLowerCase().indexOf(n) < 0;
    });
  }

  function wire() {
    document.querySelectorAll(".filter").forEach(function (box) {
      box.addEventListener("input", function () { needle = box.value; applyFilter(); });
      box.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { needle = ""; applyFilter(); }
      });
    });
    applyFilter();
  }

  function refresh() {
    if (document.hidden) return setTimeout(refresh, every);
    fetch(location.href, { headers: { Accept: "text/html" }, cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function (html) {
        var next = new DOMParser().parseFromString(html, "text/html");
        // The live region, or on a page that has none - the map editor - the tabs alone.
        var pick = document.getElementById("live") ? "#live" : ".opnav";
        var live = next.querySelector(pick);
        var cur = document.querySelector(pick);
        if (!live || !cur) return;
        var focused = document.activeElement && document.activeElement.classList.contains("filter");
        var y = window.scrollY;
        cur.replaceWith(live);
        if (pick === "#live") document.title = next.title;
        wire();
        if (focused) {
          var box = document.querySelector(".filter");
          if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
        }
        window.scrollTo(0, y);
      })
      .catch(function () {})
      .then(function () { setTimeout(refresh, every); });
  }

  // "/" focuses the filter, as it does on the terminal screen; 1-5 are the tabs in order.
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
    var tabs = ["/architect/", "/tasks", "/flows", "/pod", "/reactor"];
    if (e.key === "/") {
      var box = document.querySelector(".filter");
      if (box) { e.preventDefault(); box.focus(); }
    } else if (e.key >= "1" && e.key <= "5") {
      location.href = tabs[+e.key - 1];
    }
  });

  wire();
  setTimeout(refresh, every);
})();
