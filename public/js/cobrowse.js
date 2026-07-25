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
      o.textContent = p.name + (p.requiresLogin ? ' (login)' : '');
      sel.appendChild(o);
    });
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
      $('#openBtn').disabled = false;
      $('#fillBtn').disabled = false;
      $('#stopBtn').disabled = false;
      status('Session live. Pick a program and click "Open application", log in if it asks, then Fill.');
    } catch (_e) {
      status('Server not reachable.', true);
      $('#startBtn').disabled = false;
    }
  }

  async function open() {
    if (!session) return;
    const program = programs.find((p) => p.id === $('#programSelect').value);
    if (!program || !program.applyUrl) { status('Pick a program first (the blank option has no URL).', true); return; }
    $('#openBtn').disabled = true;
    status('Opening the application form in the browser below…');
    try {
      const res = await fetch('/api/cobrowse/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: program.applyUrl })
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { status(d.error || 'Could not open the form', true); }
      else status(`Opened ${program.name}. If it needs a login, sign in above, then click "Fill this form".`);
    } catch (_e) {
      status('Server not reachable.', true);
    } finally {
      $('#openBtn').disabled = false;
    }
  }

  async function fill() {
    if (!session) return;
    // Fill whatever page is currently open in the live browser.
    $('#fillBtn').disabled = true;
    status('Reading the form and filling it — watch the browser below…');
    $('#cbResult').hidden = true;
    const programId = $('#programSelect').value || '';
    try {
      const res = await fetch('/api/cobrowse/fill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId })
      });
      const d = await res.json();
      if (!res.ok || !d.ok) { status(d.error || 'Fill failed', true); $('#fillBtn').disabled = false; return; }
      const r = d.data;
      let msg = `Filled ${r.filled} field${r.filled === 1 ? '' : 's'}.`;
      if (r.missing && r.missing.length) msg += ` ${r.missing.length} need your input: ` + r.missing.map((m) => m.label).join(', ') + '.';
      if (r.failed) msg += ` ${r.failed} could not be filled.`;
      msg += ' Review everything, then submit yourself.';
      const box = $('#cbResult');
      box.textContent = msg;
      box.hidden = false;
      status('');
    } catch (_e) {
      status('Server not reachable during fill.', true);
    } finally {
      $('#fillBtn').disabled = false;
    }
  }

  async function stop() {
    try { await fetch('/api/cobrowse/stop', { method: 'POST' }); } catch (_e) { /* ignore */ }
    session = null;
    $('#cbFrame').src = 'about:blank';
    $('#frameCard').hidden = true;
    $('#openBtn').disabled = true;
    $('#fillBtn').disabled = true;
    $('#stopBtn').disabled = true;
    $('#startBtn').disabled = false;
    status('Session ended.');
  }

  $('#startBtn').addEventListener('click', start);
  $('#openBtn').addEventListener('click', open);
  $('#fillBtn').addEventListener('click', fill);
  $('#stopBtn').addEventListener('click', stop);
  window.addEventListener('beforeunload', () => { if (session) navigator.sendBeacon('/api/cobrowse/stop'); });

  loadPrograms();
  checkStatus();
})();
