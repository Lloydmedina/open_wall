(function () {
  "use strict";
  if (!window.electronWallpaper) return;

  function navButton(label, href, bottom) {

    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cssText =
      "position:fixed;right:22px;bottom:" + bottom + "px;z-index:2147483647;" +
      "padding:11px 20px;border-radius:999px;border:1px solid #3a4770;" +
      "background:rgba(20,26,43,.92);color:#e6eaf2;" +
      "font:600 13px/1 system-ui,sans-serif;" +
      "cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.45);" +
      "backdrop-filter:blur(6px);";
    btn.addEventListener("mouseenter", function () {
      btn.style.borderColor = "#5475f5";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.borderColor = "#3a4770";
    });
    btn.addEventListener("click", function () {
      location.href = href;
    });
    document.body.appendChild(btn);
  }

  function init() {
    navButton("Local library", "./we-library.html", 22);
    navButton("Settings", "./settings.html", 74);
  }

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
