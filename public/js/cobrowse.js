/* Live co-browse workspace: start a Steel session, embed the live view so the
   user logs in by hand, then ask the server to fill the current page. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  let session = null;
  let programs = [];

  function status(text, isErr) {
    const el = $('#cbStatus');
    el.textContent = text || '';
    el.className = 'save-status' + (text ? ' show' : '') + (isErr ? ' error' : '');
  }

  async function loadPrograms() {
    try {
      const res = await fetch('/api/programs');
      programs = await res.json();
    } catch (_e) { programs = []; }
    const sel = $('#programSelect');
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = 'Current page (I navigate myself)';
    sel.appendChild(blank);
    programs.filter((p) => p.applyUrl).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.requiresLogin ? ' 🔑 login' : ' ⚡ no-login');
      sel.appendChild(o);
    });
    updateMode();
  }

  async function checkStatus() {
    try {
      const res = await fetch('/api/cobrowse/status');
      const d = await res.json();
      if (!d.loggedIn) status('Log in on the dashboard first — co-browse needs an account.', true);
      else if (!d.configured) status('Co-browse is not configured on the server yet (needs STEEL_API_KEY).', true);
    } catch (_e) { /* ignore */ }
  }

  async function start() {
    $('#startBtn').disabled = true;
    status('Starting a live browser…');
    try {
      const res = await fetch('/api/cobrowse/start', { method: 'POST' });
      const d = await res.json();
      if (!res.ok || !d.ok) { status(d.error || 'Could not start session', true); $('#startBtn').disabled = false; return; }
      session = d.data;
      $('#cbFrame').src = session.liveViewUrl;
      $('#frameCard').hidden = false;
      $('#stopBtn').disabled = false;
      updateMode();
      status('Session live. Pick a no-login program, "Open application", tick any captcha yourself, then "Fill this form".');
    } catch (_e) {
      status('Server not reachable.', true);
      $('#startBtn').disabled = false;
    }
  }

  function selectedProgram() {
    return programs.find((p) => p.id === $('#programSelect').value);
  }

  // Route each program the right way:
  //  - login-required  -> open on the USER's own IP (they sign in cleanly)
  //  - no-login/captcha -> load into the cloud browser (residential proxy)
  function updateMode() {
    const p = selectedProgram();
    const openBtn = $('#openBtn');
    const fillBtn = $('#fillBtn');
    if (p && p.requiresLogin) {
      openBtn.textContent = 'Open in my browser (I log in) ↗';
      openBtn.title = 'Opens on YOUR IP so login is clean — a cloud IP triggers Google/MS challenges';
      openBtn.disabled = false;
      fillBtn.disabled = true;
      fillBtn.title = 'For login forms, fill in your own browser with the ⚡ Fill this extension';
    } else {
      openBtn.textContent = 'Open application ↗';
      openBtn.title = 'Loads the form in the cloud browser below (residential proxy handles captchas)';
      openBtn.disabled = !(p && p.applyUrl);
      fillBtn.disabled = !session;
      fillBtn.title = 'Fill the page open in the cloud browser';
    }
    const mf = $('#maxFillBtn');
    if (mf) mf.disabled = fillBtn.disabled;
  }

  async function open() {
    const program = selectedProgram();
    if (!program || !program.applyUrl) { status('Pick a program first (the blank option has no URL).', true); return; }

    // Login-required -> open on the user's own IP in a new tab.
    if (program.requiresLogin) {
      window.open(program.applyUrl, '_blank', 'noopener');
      status(`Opened ${program.name} in your own browser tab — you're on your own IP, so log in there. `
        + `If the LaunchPad extension is installed, use "⚡ Fill this" on the dashboard to fill it.`);
      return;
    }

    // No-login/captcha -> cloud browser (proxy). Needs a live session.
    if (!session) { status('Click "Start session" first for no-login forms.', true); return; }
    $('#openBtn').disabled = true;
    status('Opening the application form in the cloud browser below…');
    try {
      const res = await fetch('/api/cobrowse/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: program.applyUrl })
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { status(d.error || 'Could not open the form', true); }
      else status(`Opened ${program.name}. Tick any "I'm not a robot" box yourself, then click "Fill this form".`);
    } catch (_e) {
      status('Server not reachable.', true);
    } finally {
      updateMode();
    }
  }

  async function fill() {
    if (!session) return;
    // Fill whatever page is currently open in the live browser.
    $('#fillBtn').disabled = true;
    $('#maxFillBtn').disabled = true;
    status('Reading the form and filling it — watch the browser below…');
    $('#cbResult').hidden = true;
    const programId = $('#programSelect').value || '';
    try {
      const res = await fetch('/api/cobrowse/fill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId })
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { status(d.error || 'Fill failed', true); updateMode(); return; }
      // Fill runs in the background; poll for the result (no 30s timeout).
      await pollFillResult();
    } catch (_e) {
      status('Server not reachable during fill.', true);
      updateMode();
    }
  }

  async function pollFillResult() {
    const deadline = Date.now() + 120000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      let d;
      try {
        d = await (await fetch('/api/cobrowse/fill-result')).json();
      } catch (_e) { continue; } // transient — keep polling
      if (d.status === 'running') {
        if (Date.now() > deadline) { status('Fill is taking unusually long — check the browser below.', true); break; }
        continue;
      }
      if (d.status === 'error') { status('Fill error: ' + (d.error || 'unknown'), true); break; }
      if (d.status === 'done' && d.result) {
        const r = d.result;
        let msg = `Filled ${r.filled} field${r.filled === 1 ? '' : 's'}.`;
        if (r.missing && r.missing.length) msg += ` ${r.missing.length} need your input: ` + r.missing.map((m) => m.label).join(', ') + '.';
        if (r.failed) msg += ` ${r.failed} could not be filled.`;
        msg += ' Review everything, then submit yourself.';
        const box = $('#cbResult'); box.textContent = msg; box.hidden = false;
        status('');
      }
      break;
    }
    updateMode();
  }

  function toggleMax() {
    const card = $('#frameCard');
    const on = card.classList.toggle('cb-max');
    $('#maxBackdrop').hidden = !on;
    $('#maxBtn').textContent = on ? '× Close' : '⛶ Expand';
  }

  async function stop() {
    try { await fetch('/api/cobrowse/stop', { method: 'POST' }); } catch (_e) { /* ignore */ }
    session = null;
    $('#cbFrame').src = 'about:blank';
    $('#frameCard').hidden = true;
    $('#stopBtn').disabled = true;
    $('#startBtn').disabled = false;
    updateMode();
    status('Session ended.');
  }

  $('#startBtn').addEventListener('click', start);
  $('#openBtn').addEventListener('click', open);
  $('#fillBtn').addEventListener('click', fill);
  $('#maxFillBtn').addEventListener('click', fill);
  $('#stopBtn').addEventListener('click', stop);
  $('#programSelect').addEventListener('change', updateMode);
  $('#maxBtn').addEventListener('click', toggleMax);
  $('#maxBackdrop').addEventListener('click', toggleMax);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#frameCard').classList.contains('cb-max')) toggleMax();
  });
  window.addEventListener('beforeunload', () => { if (session) navigator.sendBeacon('/api/cobrowse/stop'); });

  loadPrograms();
  checkStatus();
})();
