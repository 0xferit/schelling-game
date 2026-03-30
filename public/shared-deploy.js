/* Build badge (shared across index.html and app.html) */
(function() {
  var el = document.getElementById('deploy-status');
  if (!el) return;

  var meta = el.previousElementSibling;
  var metaText = meta && typeof meta.textContent === 'string' ? meta.textContent : '';
  var isStamped =
    metaText.indexOf('__BUILD_HASH__') === -1 &&
    metaText.indexOf('__BUILD_DATE__') === -1;
  var status = isStamped ? 'success' : 'in_progress';
  var text = isStamped ? 'live build' : 'local dev';
  var dot = document.createElement('span');

  dot.className = 'dot ' + status;
  el.textContent = '';
  el.appendChild(dot);
  el.appendChild(document.createTextNode(text));
})();
