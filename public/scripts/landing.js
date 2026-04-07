/* ── Convergence Canvas ──────────────────── */
(function() {
  const canvas = document.getElementById('convergence');
  const ctx = canvas.getContext('2d');
  let w, h, particles, center;
  const PARTICLE_COUNT = 80;

  function resize() {
    var rect = canvas.parentElement.getBoundingClientRect();
    w = canvas.width = rect.width || window.innerWidth;
    h = canvas.height = rect.height || window.innerHeight;
    center = { x: w / 2, y: h / 2 };
  }

  function init() {
    resize();
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        alpha: Math.random() * 0.4 + 0.1,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const focal = { x: center.x, y: center.y * 0.9 };
    const t = Date.now() * 0.001;

    for (const p of particles) {
      // gentle pull toward focal point
      const dx = focal.x - p.x;
      const dy = focal.y - p.y;
      const pull = 0.00015;
      p.vx += dx * pull;
      p.vy += dy * pull;

      // slight orbital drift
      p.vx += Math.sin(t + p.phase) * 0.003;
      p.vy += Math.cos(t + p.phase) * 0.003;

      // damping
      p.vx *= 0.995;
      p.vy *= 0.995;

      p.x += p.vx;
      p.y += p.vy;

      // wrap
      if (p.x < -20) p.x = w + 20;
      if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20;
      if (p.y > h + 20) p.y = -20;

      // draw
      const glow = Math.sin(t * 0.5 + p.phase) * 0.15 + 0.85;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(201,168,76,${p.alpha * glow})`;
      ctx.fill();

      // draw lines to nearby particles
      for (const q of particles) {
        if (q === p) continue;
        const ddx = q.x - p.x;
        const ddy = q.y - p.y;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < 100) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `rgba(201,168,76,${0.04 * (1 - d / 100)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(draw);
  }

  init();
  draw();
  window.addEventListener('resize', resize);
})();

var gameConfigPromise = fetch('/api/game-config')
  .then(function(response) {
    if (!response.ok) throw new Error('Unable to load game config');
    return response.json();
  })
  .catch(function() {
    return {
      commitDuration: null,
      revealDuration: null,
      turnstileSiteKey: null
    };
  });

/* ── Example option interaction ──────────── */
(function() {
  var demo = document.querySelector('.example-layout');
  var opts = document.querySelectorAll('.example-opt');
  var insight = document.querySelector('.example-insight');
  var status = document.querySelector('.example-vote-status');
  var turnstileContainer = document.getElementById('example-turnstile');
  var configLoaded = false;
  var siteKey = null;
  var widgetId = null;
  var widgetInitPromise = null;
  var pendingChallenge = null;

  if (!demo || !opts.length || !insight || !status || !turnstileContainer) return;

  // Inject vote-bar and vote-pct elements into each option
  opts.forEach(function(opt) {
    var bar = document.createElement('div');
    bar.className = 'vote-bar';
    var pct = document.createElement('div');
    pct.className = 'vote-pct';
    opt.appendChild(bar);
    opt.appendChild(pct);
  });

  function setStatus(message, tone) {
    status.textContent = message || '';
    status.classList.remove('pending', 'error', 'success');
    if (tone) status.classList.add(tone);
  }

  function setDemoDisabled(disabled) {
    demo.classList.toggle('demo-disabled', disabled);
  }

  function rejectPendingChallenge(message) {
    if (!pendingChallenge) return;
    var current = pendingChallenge;
    pendingChallenge = null;
    current.reject(new Error(message));
  }

  function resetTurnstileWidget() {
    pendingChallenge = null;
    if (window.turnstile && widgetId !== null) {
      window.turnstile.reset(widgetId);
    }
  }

  function waitForTurnstileReady() {
    return new Promise(function(resolve, reject) {
      var startedAt = Date.now();

      function check() {
        if (window.turnstile && typeof window.turnstile.render === 'function') {
          resolve(window.turnstile);
          return;
        }
        if (Date.now() - startedAt > 5000) {
          reject(new Error('Human verification failed to load. Please try again.'));
          return;
        }
        setTimeout(check, 50);
      }

      check();
    });
  }

  function ensureTurnstileWidget() {
    if (!siteKey) {
      return Promise.reject(new Error('Demo voting is temporarily unavailable.'));
    }
    if (widgetId !== null) {
      turnstileContainer.hidden = false;
      return Promise.resolve(widgetId);
    }
    if (widgetInitPromise) return widgetInitPromise;

    turnstileContainer.hidden = false;
    widgetInitPromise = waitForTurnstileReady()
      .then(function(turnstile) {
        widgetId = turnstile.render(turnstileContainer, {
          sitekey: siteKey,
          action: 'landing_example_vote',
          appearance: 'interaction-only',
          execution: 'execute',
          callback: function(token) {
            if (!pendingChallenge) return;
            var current = pendingChallenge;
            pendingChallenge = null;
            current.resolve(token);
          },
          'error-callback': function() {
            rejectPendingChallenge('Human verification failed. Please try again.');
          },
          'expired-callback': function() {
            rejectPendingChallenge('Verification expired. Please try again.');
          },
          'timeout-callback': function() {
            rejectPendingChallenge('Verification timed out. Please try again.');
          }
        });
        return widgetId;
      })
      .catch(function(error) {
        widgetInitPromise = null;
        turnstileContainer.hidden = true;
        throw error;
      });

    return widgetInitPromise;
  }

  function runTurnstileChallenge() {
    return ensureTurnstileWidget().then(function(id) {
      return new Promise(function(resolve, reject) {
        pendingChallenge = { resolve: resolve, reject: reject };
        try {
          window.turnstile.execute(id);
        } catch (error) {
          pendingChallenge = null;
          reject(error instanceof Error ? error : new Error('Human verification failed. Please try again.'));
        }
      });
    });
  }

  function submitExampleVote(idx, token) {
    return fetch('/api/example-vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionIndex: idx, turnstileToken: token })
    }).then(function(response) {
      if (response.ok) return response.json();

      return response.json()
        .catch(function() { return {}; })
        .then(function(body) {
          var message = body && body.error ? body.error : 'Unable to record vote right now.';
          throw new Error(message);
        });
    });
  }

  function renderTally(data) {
    if (!data || !data.total) return;
    // Build a lookup: optionIndex -> count
    var counts = {};
    var maxCount = 0;
    data.votes.forEach(function(v) {
      counts[v.optionIndex] = v.count;
      if (v.count > maxCount) maxCount = v.count;
    });

    // Animate bars and show percentages
    opts.forEach(function(opt, idx) {
      var count = counts[idx] || 0;
      var pct = data.total > 0 ? Math.round((count / data.total) * 100) : 0;
      var bar = opt.querySelector('.vote-bar');
      var label = opt.querySelector('.vote-pct');
      label.textContent = pct > 0 ? pct + '%' : '';
      // Use maxCount for bar scaling so the top answer fills 100%
      var barWidth = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
      setTimeout(function() { bar.style.width = barWidth + '%'; }, 50);
    });

    demo.classList.add('has-tally');

    // Update insight with the winner
    var topVote = data.votes.reduce(function(a, b) { return b.count > a.count ? b : a; }, { count: 0 });
    var topPct = Math.round((topVote.count / data.total) * 100);
    var topLabel = opts[topVote.optionIndex] ? opts[topVote.optionIndex].childNodes[0].textContent.trim() : '?';
    insight.textContent = topPct + '% of ' + data.total + ' visitors picked ' + topLabel + '. '
      + 'It is the only non-prime, the only round number, and the only three-digit number in the set. '
      + 'That salience makes it the natural coordination target: the focal point.';
  }

  function revealWithTally() {
    demo.classList.add('revealed');
    demo.classList.remove('verifying', 'demo-disabled');
    turnstileContainer.hidden = true;
    opts.forEach(function(o) { o.style.cursor = 'default'; });
    fetch('/api/example-tally')
      .then(function(r) { return r.json(); })
      .then(renderTally)
      .catch(function() {});
  }

  // If already voted, show results immediately and mark their pick
  var votedIdx = localStorage.getItem('example-voted');
  if (votedIdx !== null) {
    var idx = parseInt(votedIdx, 10);
    if (!isNaN(idx) && opts[idx]) opts[idx].classList.add('my-pick');
    revealWithTally();
  } else {
    setStatus('Loading human verification…', 'pending');

    gameConfigPromise.then(function(cfg) {
      configLoaded = true;
      siteKey = cfg && typeof cfg.turnstileSiteKey === 'string' && cfg.turnstileSiteKey.trim()
        ? cfg.turnstileSiteKey.trim()
        : null;

      if (!siteKey) {
        setDemoDisabled(true);
        setStatus('Demo voting is temporarily unavailable.', 'error');
        return;
      }

      setDemoDisabled(false);
      setStatus('', '');
    });

    opts.forEach(function(opt, idx) {
      opt.addEventListener('click', function() {
        if (
          demo.classList.contains('revealed') ||
          demo.classList.contains('verifying') ||
          demo.classList.contains('demo-disabled')
        ) {
          return;
        }
        if (!configLoaded) {
          setStatus('Loading human verification…', 'pending');
          return;
        }

        opt.classList.add('my-pick');
        demo.classList.add('verifying');
        setStatus('Checking that you are human…', 'pending');

        runTurnstileChallenge()
          .then(function(token) {
            return submitExampleVote(idx, token);
          })
          .then(function() {
            localStorage.setItem('example-voted', String(idx));
            setStatus('Vote recorded. Loading tally…', 'success');
            revealWithTally();
          })
          .catch(function(error) {
            demo.classList.remove('verifying');
            resetTurnstileWidget();
            turnstileContainer.hidden = false;
            setStatus(
              error && error.message ? error.message : 'Unable to record vote right now.',
              'error',
            );
          });
      });
    });
  }
})();

/* ── Phase durations from server (single source of truth) ── */
gameConfigPromise.then(function(cfg) {
  var commitSeconds = document.getElementById('commit-seconds');
  if (commitSeconds && typeof cfg.commitDuration === 'number') {
    commitSeconds.textContent = cfg.commitDuration;
  }
}).catch(function() {});

/* ── Landing stats ───────────────────────── */
(function() {
  function formatInt(value) {
    return new Intl.NumberFormat().format(value);
  }

  fetch('/api/landing-stats').then(function(r) { return r.json(); }).then(function(stats) {
    document.getElementById('stat-players-24h').textContent = formatInt(stats.playersLast24h || 0);
    document.getElementById('stat-completed-matches').textContent = formatInt(stats.completedMatches || 0);
    document.getElementById('stat-longest-streak').textContent = formatInt(stats.longestStreak || 0);
  }).catch(function() {});
})();

/* ── Build stamp formatting ───────────────── */
(function() {
  var stamp = document.querySelector('.build-stamp');
  if (!stamp) return;

  var hash = stamp.getAttribute('data-build-hash');
  var rawDate = stamp.getAttribute('data-build-date');
  if (!hash || !rawDate) return;

  var parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return;

  var formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  });

  stamp.textContent = hash + ' · ' + formatter.format(parsed);
  stamp.title = rawDate + ' UTC';
})();
