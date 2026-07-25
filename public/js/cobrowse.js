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
      $('#fillBtn').disabled = false;
      $('#stopBtn').disabled = false;
      status('Session live. Log into your account in the browser below, open the application page, then Fill.');
    } catch (_e) {
      status('Server not reachable.', true);
      $('#startBtn').disabled = false;
    }
  }

  async function fill() {
    if (!session) return;
    const programId = $('#programSelect').value;
    const program = programs.find((p) => p.id === programId);
    const applyUrl = program ? program.applyUrl : '';
    $('#fillBtn').disabled = true;
    status('Reading the form and filling it — watch the browser below…');
    $('#cbResult').hidden = true;
    try {
      const res = await fetch('/api/cobrowse/fill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applyUrl })
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
    $('#fillBtn').disabled = true;
    $('#stopBtn').disabled = true;
    $('#startBtn').disabled = false;
    status('Session ended.');
  }

  $('#startBtn').addEventListener('click', start);
  $('#fillBtn').addEventListener('click', fill);
  $('#stopBtn').addEventListener('click', stop);
  window.addEventListener('beforeunload', () => { if (session) navigator.sendBeacon('/api/cobrowse/stop'); });

  loadPrograms();
  checkStatus();
})();
