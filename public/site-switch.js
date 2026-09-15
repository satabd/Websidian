// Site switcher in the header (only rendered when the server has several sites).
// A script instead of an inline onchange="" so pages work under a strict CSP.
(function () {
  'use strict';
  document.querySelectorAll('select.site-switch').forEach(function (sel) {
    sel.addEventListener('change', function () { location.href = sel.value + (sel.getAttribute('data-suffix') || ''); });
  });
})();
