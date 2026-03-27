/* Deploy status indicator (shared across index.html and app.html) */
(function() {
  var el = document.getElementById('deploy-status');
  var labels = { success: 'deployed', in_progress: 'deploying new version', failure: 'deploy failed' };
  var pending = false;
  var timer = null;

  function schedule() {
    clearInterval(timer);
    // 15s while deploying, 90s otherwise (stays under 60 req/hr GitHub limit)
    timer = setInterval(check, pending ? 15000 : 90000);
  }

  function check() {
    fetch('https://api.github.com/repos/0xferit/schelling-game/actions/runs?per_page=1&branch=main')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.workflow_runs || !data.workflow_runs.length) return;
        var run = data.workflow_runs[0];
        var status = run.status === 'completed' ? run.conclusion : 'in_progress';
        var text = labels[status] || status;
        el.innerHTML = '<span class="dot ' + status + '"></span>' + text;
        if ((status === 'in_progress') !== pending) {
          pending = status === 'in_progress';
          schedule();
        }
      })
      .catch(function() {});
  }

  check();
  schedule();
})();
