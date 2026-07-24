/* ============================================================
   LaunchPad dashboard — vanilla JS, no framework, no build step.
   Talks to the Agent A server on the same origin (localhost:3000).
   ============================================================ */

(() => {
  'use strict';

  /* ---- All profile fields (dotted keys) used for the completeness meter.
         Order/shape mirrors the schema in ARCHITECTURE.md. ---- */
  const ALL_FIELDS = [
    'basic.startupName', 'basic.website', 'basic.email',
    'basic.description', 'basic.country', 'basic.foundedYear',
    'extended.stage', 'extended.fundingRaised', 'extended.teamSize',
    'extended.industry', 'extended.linkedin', 'extended.pitch',
    'extended.techStack', 'extended.monthlyCloudSpend',
    'extended.incorporated', 'extended.founderName', 'extended.founderRole'
  ];

  /* Human-readable labels. Falls back to a generic prettifier for
     any key the server sends that we don't explicitly know. */
  const LABELS = {
    'basic.startupName': 'Startup name',
    'basic.website': 'Website',
    'basic.email': 'Contact email',
    'basic.description': 'Description',
    'basic.country': 'Country',
    'basic.foundedYear': 'Founded year',
    'extended.stage': 'Stage',
    'extended.fundingRaised': 'Funding raised',
    'extended.teamSize': 'Team size',
    'extended.industry': 'Industry',
    'extended.linkedin': 'LinkedIn',
    'extended.pitch': 'Elevator pitch',
    'extended.techStack': 'Tech stack',
    'extended.monthlyCloudSpend': 'Monthly cloud spend',
    'extended.incorporated': 'Incorporated',
    'extended.founderName': 'Founder name',
    'extended.founderRole': 'Founder role'
  };

  function prettifyKey(key) {
    if (LABELS[key]) return LABELS[key];
    const last = String(key).split('.').pop() || key;
    const spaced = last
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  }

  /* ---- tiny DOM helpers ---- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const esc = (s) => String(s == null ? '' : s);

  /* Nested get/set on { basic:{}, extended:{} } via dotted key. */
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
  }
  function setPath(obj, path, val) {
    const parts = path.split('.');
    const last = parts.pop();
    let cur = obj;
    for (const p of parts) { cur[p] = cur[p] || {}; cur = cur[p]; }
    cur[last] = val;
  }
  const isFilled = (v) => v != null && String(v).trim() !== '';

  /* ---- state ---- */
  const form = $('#profileForm');
  let unlockedBefore = new Set();   // program ids unlocked prior to last save
  let firstRender = true;

  /* ======================= PROFILE ======================= */

  function buildProfileFromForm() {
    const profile = { basic: {}, extended: {} };
    ALL_FIELDS.forEach((key) => {
      const input = form.elements[key];
      setPath(profile, key, input ? input.value.trim() : '');
    });
    return profile;
  }

  function populateForm(profile) {
    ALL_FIELDS.forEach((key) => {
      const input = form.elements[key];
      if (input) input.value = esc(getPath(profile, key));
    });
    updateCompleteness();
  }

  function updateCompleteness() {
    const values = ALL_FIELDS.map((k) => form.elements[k] && form.elements[k].value);
    const filled = values.filter(isFilled).length;
    const pct = Math.round((filled / ALL_FIELDS.length) * 100);

    $('#completenessPct').textContent = pct + '%';
    $('#meterFill').style.width = pct + '%';
    const meter = $('#meter');
    meter.setAttribute('aria-valuenow', String(pct));

    const hint = $('#completenessHint');
    if (pct === 100) hint.textContent = 'Every field complete — you are eligible for the most programs. Nice.';
    else hint.textContent = `${ALL_FIELDS.length - filled} field${ALL_FIELDS.length - filled === 1 ? '' : 's'} left. Each one you add can unlock more programs.`;
  }

  async function loadProfile() {
    try {
      const res = await fetch('/api/profile');
      if (!res.ok) throw new Error('bad status ' + res.status);
      const profile = await res.json();
      populateForm(profile || {});
    } catch (err) {
      // No profile yet / server not ready — start blank, still usable.
      populateForm({ basic: {}, extended: {} });
      console.warn('Could not load profile:', err);
    }
  }

  /* ======================= AUTH ======================= */

  let currentUser = null;
  let authMode = 'login'; // 'login' | 'register'

  function renderAuthArea() {
    const area = $('#authArea');
    if (!area) return;
    area.textContent = '';
    if (currentUser) {
      const name = el('span', 'auth-user', '@' + currentUser.username);
      const out = el('button', 'btn btn-ghost auth-btn', 'Log out');
      out.type = 'button';
      out.addEventListener('click', async () => {
        try { await fetch('/api/logout', { method: 'POST' }); } catch (_e) { /* ignore */ }
        currentUser = null;
        renderAuthArea();
        await loadProfile();
        await loadPrograms();
      });
      area.appendChild(name);
      area.appendChild(out);
    } else {
      const btn = el('button', 'btn btn-primary auth-btn', 'Log in / Sign up');
      btn.type = 'button';
      btn.addEventListener('click', () => openAuth('login'));
      area.appendChild(btn);
    }
  }

  function setAuthMode(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    $('#authTitle').textContent = isLogin ? 'Log in' : 'Create your account';
    $('#authSubmit').textContent = isLogin ? 'Log in' : 'Sign up';
    $('#authSwitchText').textContent = isLogin ? 'No account yet?' : 'Already have an account?';
    $('#authSwitch').textContent = isLogin ? 'Create one' : 'Log in';
    $('#authPassword').setAttribute('autocomplete', isLogin ? 'current-password' : 'new-password');
    const errEl = $('#authError');
    errEl.hidden = true;
  }

  function openAuth(mode) {
    setAuthMode(mode);
    $('#authOverlay').hidden = false;
    $('#authUsername').focus();
  }

  async function submitAuth(evt) {
    evt.preventDefault();
    const errEl = $('#authError');
    errEl.hidden = true;
    const username = $('#authUsername').value.trim();
    const password = $('#authPassword').value;
    const btn = $('#authSubmit');
    btn.disabled = true;
    try {
      const res = await fetch(authMode === 'login' ? '/api/login' : '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        errEl.textContent = data.error || 'Something went wrong — try again.';
        errEl.hidden = false;
        return;
      }
      currentUser = data.user;
      $('#authOverlay').hidden = true;
      $('#authPassword').value = '';
      renderAuthArea();
      await loadProfile();
      await loadPrograms({ animate: true });
    } catch (_e) {
      errEl.textContent = 'Server not reachable.';
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function initAuth() {
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
      currentUser = data && data.user ? data.user : null;
    } catch (_e) {
      currentUser = null;
    }
    renderAuthArea();
    // On a deployed (non-localhost) instance, an account is the only way to
    // keep a profile — prompt right away when anonymous.
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!currentUser && !isLocal) openAuth('login');
  }

  $('#authForm').addEventListener('submit', submitAuth);
  $('#authSwitch').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });
  $('#authClose').addEventListener('click', () => { $('#authOverlay').hidden = true; });
  $('#authOverlay').addEventListener('click', (ev) => {
    if (ev.target === $('#authOverlay')) $('#authOverlay').hidden = true;
  });

  async function saveProfile(evt) {
    evt.preventDefault();
    const btn = $('#saveBtn');
    const status = $('#saveStatus');
    const profile = buildProfileFromForm();

    btn.disabled = true;
    status.className = 'save-status';
    status.textContent = 'Saving…';
    status.classList.add('show');

    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile)
      });
      if (!res.ok) throw new Error('bad status ' + res.status);

      status.textContent = 'Saved ✓';
      status.classList.add('show');
      // Re-fetch so newly-eligible cards unlock with a reward animation.
      await loadPrograms({ animate: true });
      window.setTimeout(() => status.classList.remove('show'), 2600);
    } catch (err) {
      status.textContent = 'Could not save — is the server running?';
      status.className = 'save-status error show';
      console.error('Save failed:', err);
    } finally {
      btn.disabled = false;
    }
  }

  /* ======================= PROGRAMS ======================= */

  function listBlock(titleText, items, extraClass) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('p', 'list-title', titleText));
    const ul = el('ul', 'program-list' + (extraClass ? ' ' + extraClass : ''));
    items.forEach((it) => ul.appendChild(el('li', null, it)));
    frag.appendChild(ul);
    return frag;
  }

  function renderUnlockedCard(p, animate) {
    const card = el('div', 'program unlocked');
    if (animate && !unlockedBefore.has(p.id)) card.classList.add('just-unlocked');

    // head
    const head = el('div', 'program-head');
    head.appendChild(el('div', 'program-logo', p.logoEmoji || '🎁'));
    const titles = el('div', 'program-titles');
    titles.appendChild(el('h3', 'program-name', p.name || 'Program'));
    if (p.provider) titles.appendChild(el('p', 'program-provider', p.provider));
    const tags = el('div', 'program-tags');
    tags.appendChild(el('span', p.tier === 'live' ? 'badge badge-live' : 'badge', p.tier === 'live' ? 'Live' : 'Unlocked'));
    if (p.requiresLogin) tags.appendChild(el('span', 'badge badge-muted', 'Login required'));
    titles.appendChild(tags);
    head.appendChild(titles);
    card.appendChild(head);

    if (p.benefitSummary) card.appendChild(el('p', 'program-summary', p.benefitSummary));

    if (Array.isArray(p.benefits) && p.benefits.length)
      card.appendChild(listBlock('Benefits', p.benefits));

    if (Array.isArray(p.eligibility) && p.eligibility.length)
      card.appendChild(listBlock('Eligibility', p.eligibility, 'eligibility'));

    if (Array.isArray(p.approvalTips) && p.approvalTips.length) {
      const details = el('details', 'tips');
      details.appendChild(el('summary', null, 'Approval tips'));
      details.appendChild(listBlock('', p.approvalTips));
      // remove the empty title paragraph the helper added
      const t = details.querySelector('.list-title');
      if (t) t.remove();
      card.appendChild(details);
    }

    const foot = el('div', 'program-foot');
    if (p.applyUrl) {
      const fill = el('button', 'btn btn-fill', '⚡ Fill this');
      fill.type = 'button';
      fill.title = 'Open the application and let LaunchPad Agent fill it (you review & submit)';
      fill.addEventListener('click', () => requestAutofill(p));
      foot.appendChild(fill);
    }
    const apply = el('a', 'btn btn-primary apply-btn', 'Apply Now →');
    apply.href = 'apply.html?program=' + encodeURIComponent(p.id);
    foot.appendChild(apply);
    card.appendChild(foot);

    return card;
  }

  function renderLockedCard(p) {
    const card = el('div', 'program locked');
    const missing = Array.isArray(p.missingFields) ? p.missingFields : [];

    const ribbon = el('div', 'lock-ribbon');
    ribbon.appendChild(document.createTextNode('🔒 Add ' + missing.length + ' more field' + (missing.length === 1 ? '' : 's') + ' to unlock'));
    card.appendChild(ribbon);

    const head = el('div', 'program-head');
    head.appendChild(el('div', 'program-logo', p.logoEmoji || '🎁'));
    const titles = el('div', 'program-titles');
    titles.appendChild(el('h3', 'program-name', p.name || 'Program'));
    if (p.provider) titles.appendChild(el('p', 'program-provider', p.provider));
    head.appendChild(titles);
    card.appendChild(head);

    if (p.benefitSummary) card.appendChild(el('p', 'program-summary', p.benefitSummary));

    if (missing.length) {
      const block = el('div', 'missing-block');
      block.appendChild(el('p', 'list-title', 'Complete these to unlock'));
      const chips = el('div', 'missing-chips');
      missing.forEach((k) => chips.appendChild(el('span', 'missing-chip', prettifyKey(k))));
      block.appendChild(chips);
      card.appendChild(block);
    }
    return card;
  }

  function renderPrograms(programs, animate) {
    const unlockedGrid = $('#unlockedGrid');
    const lockedGrid = $('#lockedGrid');
    const lockedWrap = $('#lockedWrap');
    const banner = $('#unlockBanner');
    const stateNote = $('#programsState');
    const pill = $('#programCountPill');

    unlockedGrid.innerHTML = '';
    lockedGrid.innerHTML = '';

    // Empty / error state
    if (!Array.isArray(programs) || programs.length === 0) {
      stateNote.hidden = false;
      stateNote.innerHTML = '<strong>No programs to show yet.</strong><br>The programs catalog is still loading. Once it is available, matched credit programs will appear here.';
      lockedWrap.hidden = true;
      banner.hidden = true;
      pill.textContent = '0 programs';
      return;
    }
    stateNote.hidden = true;

    const unlocked = programs.filter((p) => p.unlocked);
    const locked = programs.filter((p) => !p.unlocked);

    // live tier first, then others; stable within groups
    unlocked.sort((a, b) => (a.tier === 'live' ? 0 : 1) - (b.tier === 'live' ? 0 : 1));

    unlocked.forEach((p) => unlockedGrid.appendChild(renderUnlockedCard(p, animate)));

    if (unlocked.length === 0) {
      stateNote.hidden = false;
      stateNote.innerHTML = '<strong>No programs unlocked yet.</strong><br>Fill in your profile above and hit Save — programs unlock as you go.';
    }

    // locked section
    if (locked.length) {
      locked.forEach((p) => lockedGrid.appendChild(renderLockedCard(p)));
      lockedWrap.hidden = false;

      const distinctMissing = new Set();
      locked.forEach((p) => (p.missingFields || []).forEach((k) => distinctMissing.add(k)));
      const X = distinctMissing.size;
      const Y = locked.length;
      banner.hidden = false;
      banner.textContent = `Complete ${X} more profile field${X === 1 ? '' : 's'} to unlock ${Y} more program${Y === 1 ? '' : 's'}.`;
    } else {
      lockedWrap.hidden = true;
      banner.hidden = false;
      banner.textContent = 'All programs unlocked. You are ready to apply everywhere.';
    }

    pill.textContent = `${unlocked.length} of ${programs.length} unlocked`;

    // record for next diff
    unlockedBefore = new Set(unlocked.map((p) => p.id));
  }

  async function loadPrograms(opts = {}) {
    const animate = !!opts.animate && !firstRender;
    try {
      const res = await fetch('/api/programs');
      if (!res.ok) throw new Error('bad status ' + res.status);
      const programs = await res.json();
      renderPrograms(programs, animate);
    } catch (err) {
      const stateNote = $('#programsState');
      stateNote.hidden = false;
      stateNote.innerHTML = '<strong>Could not reach the programs service.</strong><br>Make sure the LaunchPad server is running on localhost:3000, then reload.';
      $('#unlockedGrid').innerHTML = '';
      $('#lockedWrap').hidden = true;
      $('#unlockBanner').hidden = true;
      $('#programCountPill').textContent = 'Offline';
      console.error('Load programs failed:', err);
    } finally {
      firstRender = false;
    }
  }

  /* =============== LaunchPad Agent (extension) bridge ===============
     The extension's content script announces itself on this page with
     postMessage {source:'launchpad-agent', type:'AGENT_READY'}. Clicking
     "⚡ Fill this" posts FILL_PROGRAM back; the extension opens the
     application tab, scans, generates truthful answers and fills them —
     never submitting. Progress comes back as FILL_STARTED / FILL_RESULT. */

  let agentReady = false;

  function toast(text, opts = {}) {
    let holder = $('#agentToasts');
    if (!holder) {
      holder = el('div', null);
      holder.id = 'agentToasts';
      document.body.appendChild(holder);
    }
    const t = el('div', 'agent-toast' + (opts.error ? ' error' : ''), text);
    holder.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    window.setTimeout(() => {
      t.classList.remove('show');
      window.setTimeout(() => t.remove(), 400);
    }, opts.sticky ? 12000 : 6000);
  }

  function showInstallHelp() {
    // Modal "Add to Chrome" experience. A web page cannot install an
    // extension directly (Chrome removed inline installs in 2018), but the
    // local server can launch Chrome for us — that plus a clipboard copy of
    // the extension path gets within one click of the store experience.
    let overlay = $('#agentInstallOverlay');
    if (overlay) { overlay.hidden = false; return; }

    overlay = el('div', 'agent-modal-overlay');
    overlay.id = 'agentInstallOverlay';

    const modal = el('div', 'agent-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    modal.appendChild(el('h3', 'agent-modal-title', 'Add LaunchPad Agent to Chrome'));
    modal.appendChild(el('p', 'agent-modal-sub',
      'The autofill agent is a Chrome extension. Chrome only allows one-click installs from its Web Store, so this is the next best thing — a one-time, ~20 second setup:'));

    const steps = el('ol', 'agent-modal-steps');
    [
      'Click "Add to Chrome" below — Chrome opens the extensions page and the folder path is copied to your clipboard.',
      'Switch on "Developer mode" (top-right toggle).',
      'Click "Load unpacked" and paste the copied path into the folder picker.'
    ].forEach((s) => steps.appendChild(el('li', null, s)));
    modal.appendChild(steps);

    const btnRow = el('div', 'agent-modal-actions');

    const addBtn = el('button', 'btn btn-primary', 'Add to Chrome');
    addBtn.type = 'button';
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        const res = await fetch('/api/install-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'open' })
        });
        const data = await res.json().catch(() => ({}));
        if (data.extensionPath && navigator.clipboard) {
          try { await navigator.clipboard.writeText(data.extensionPath); } catch (_e) { /* ignore */ }
        }
        if (data.ok) {
          toast('Chrome extensions page opened — path copied. Developer mode → Load unpacked → paste.', { sticky: true });
        } else {
          toast((data.error || 'Could not launch Chrome') + '. Path: ' + (data.extensionPath || 'extension folder'), { error: true, sticky: true });
        }
      } catch (_e) {
        toast('Server not reachable — is LaunchPad running?', { error: true });
      } finally {
        addBtn.disabled = false;
      }
    });
    btnRow.appendChild(addBtn);

    const quickBtn = el('button', 'btn btn-fill', 'Quick try (this session)');
    quickBtn.type = 'button';
    quickBtn.title = 'Launches a Chrome window with the agent pre-loaded — no setup, lasts until Chrome fully closes';
    quickBtn.addEventListener('click', async () => {
      quickBtn.disabled = true;
      try {
        const res = await fetch('/api/install-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'load' })
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
          toast('New Chrome window launching with the agent loaded — use the dashboard there.', { sticky: true });
        } else {
          toast(data.error || 'Could not launch Chrome', { error: true });
        }
      } catch (_e) {
        toast('Server not reachable — is LaunchPad running?', { error: true });
      } finally {
        quickBtn.disabled = false;
      }
    });
    btnRow.appendChild(quickBtn);

    const closeBtn = el('button', 'btn btn-ghost', 'Close');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { overlay.hidden = true; });
    btnRow.appendChild(closeBtn);

    modal.appendChild(btnRow);
    modal.appendChild(el('p', 'agent-modal-note',
      'Once added, this dialog never appears again — "⚡ Fill this" goes straight to work. Note: if Chrome ignores the quick-try window (newer versions block it), use the 3-step install.'));

    overlay.appendChild(modal);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.hidden = true; });
    document.body.appendChild(overlay);
  }

  function requestAutofill(p) {
    if (!agentReady) { showInstallHelp(); return; }
    window.postMessage(
      { source: 'launchpad-dashboard', type: 'FILL_PROGRAM', applyUrl: p.applyUrl, programId: p.id },
      window.location.origin
    );
  }

  window.addEventListener('message', (ev) => {
    if (ev.origin !== window.location.origin || ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'launchpad-agent') return;

    if (d.type === 'AGENT_READY') {
      agentReady = true;
      document.body.classList.add('agent-on');
      return;
    }
    if (d.type === 'FILL_STARTED') {
      if (d.ok) toast('⚡ Agent launched — opening the application and filling it…');
      else toast('Agent could not start: ' + (d.error || 'unknown error'), { error: true });
      return;
    }
    if (d.type === 'FILL_RESULT') {
      if (d.error) {
        toast('Autofill: ' + d.error, { error: true });
        return;
      }
      let msg = '✓ Filled ' + d.filled + ' field' + (d.filled === 1 ? '' : 's') +
        (d.host ? ' on ' + d.host : '');
      if (d.missing > 0) msg += ' — ' + d.missing + ' need' + (d.missing === 1 ? 's' : '') + ' your input';
      if (d.failed > 0) msg += ' (' + d.failed + ' left for manual fill)';
      msg += '. Review everything, then submit yourself.';
      toast(msg, { sticky: d.missing > 0 || d.failed > 0 });
    }
  });

  // Ask an already-injected content script to announce itself (covers the
  // case where the extension loaded before this page's listeners attached).
  window.postMessage({ source: 'launchpad-dashboard', type: 'PING' }, window.location.origin);

  /* ======================= WIRE UP ======================= */
  form.addEventListener('submit', saveProfile);
  form.addEventListener('input', updateCompleteness);
  form.addEventListener('change', updateCompleteness);

  initAuth().then(() => {
    loadProfile();
    loadPrograms();
  });
})();
