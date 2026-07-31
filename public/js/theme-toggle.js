/* Shared light/dark toggle. The <head> inline script already applied the saved
   theme (no flash); this just wires the #themeToggle button on any page. */
(function () {
  'use strict';
  function icon() { return document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'; }
  function sync() { var b = document.getElementById('themeToggle'); if (b) b.textContent = icon(); }
  var btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('lp-theme', next); } catch (e) {}
      sync();
    });
  }
  sync();
})();
