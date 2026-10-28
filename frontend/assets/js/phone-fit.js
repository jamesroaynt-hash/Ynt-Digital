/* Phone fit: under 640px a wide table turns into one card per row.
   Each cell gets data-label from its column header, and the CSS in the
   PHONE FIT block of main.css prints that label beside the value.

   Only plain list tables qualify: one header row, no rowspan, at least
   4 columns. Matrices and calendars keep the sideways swipe, and any
   table can opt out with class="no-cards". */
(function () {
  var mq = window.matchMedia('(max-width: 640px)');
  var SKIP = '.no-cards, .data-report-table, .hrr-calendar, .ev-matrix, .gs-mirror';

  function headerLabels(table) {
    if (!table.tHead || table.tHead.rows.length !== 1) return null;
    var labels = [];
    Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th) {
      var text = th.textContent.replace(/\s+/g, ' ').trim();
      for (var i = 0; i < (th.colSpan || 1); i++) labels.push(text);
    });
    return labels.length >= 4 ? labels : null;
  }

  function fitTable(table) {
    if (table.closest(SKIP) || table.querySelector('[rowspan]:not([rowspan="1"])')) return;
    var labels = headerLabels(table);
    if (!labels) return;
    table.classList.add('m-cards');
    Array.prototype.forEach.call(table.tBodies, function (tbody) {
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        var col = 0;
        Array.prototype.forEach.call(tr.cells, function (td) {
          if (!td.hasAttribute('data-label')) {
            td.setAttribute('data-label', (td.colSpan || 1) > 1 ? '' : (labels[col] || ''));
          }
          col += td.colSpan || 1;
        });
      });
    });
  }

  var queued = false;
  function scan() {
    queued = false;
    if (!mq.matches) return;
    document.querySelectorAll('.page-content table, .modal table').forEach(fitTable);
  }
  function queue() {
    if (queued || !mq.matches) return;
    queued = true;
    requestAnimationFrame(scan);
  }

  new MutationObserver(queue).observe(document.documentElement, { childList: true, subtree: true });
  if (mq.addEventListener) mq.addEventListener('change', queue); else mq.addListener(queue);
  queue();
})();
