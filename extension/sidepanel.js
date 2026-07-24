/**
 * LaunchPad Agent — side panel controller (Agent C)
 *
 * Owns the panel UI: scan the active tab's form, ask the background service
 * worker to generate truthful answers, let the user edit them inline, then
 * fill the page. Submit is never automated.
 *
 * Message protocol (see SPEC.md):
 *   SCAN_FORM       sidepanel -> content  (active tab)
 *   GENERATE_ANSWERS sidepanel -> background
 *   FILL_FIELDS     sidepanel -> content
 *   SYNC_PROFILE    sidepanel -> background
 * Every response is {ok:true, data} or {ok:false, error}.
 *
 * All page-derived strings (labels, notes, options) are rendered with
 * textContent / createElement only — never innerHTML — to prevent XSS.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} Item
 * @property {string}  fid
 * @property {string}  label
 * @property {string}  kind
 * @property {string}  value    current (possibly edited) answer text
 * @property {string}  note
 * @property {boolean} missing  true while unresolved and untouched
 * @property {string}  confidence "high"|"medium"|"low"
 */

const state = {
  /** @type {Item[]} */ items: [],
  scan: null, // {url, title, fields}
  busy: false,
};

/* Human-readable model labels for the toolbar badge. */
const MODEL_LABELS = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-fable-5': 'Fable 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

/* ------------------------------------------------------------------ */
/* Element refs                                                       */
/* ------------------------------------------------------------------ */

const el = {};
function cacheEls() {
  [
    'statusDot', 'statusText', 'modelBadge', 'syncBtn', 'settingsBtn',
    'bannerRegion', 'scanBtn', 'scanMeta', 'answers', 'emptyState',
    'fillBtn', 'fillResult', 'toast',
  ].forEach((id) => { el[id] = document.getElementById(id); });
}

/* ------------------------------------------------------------------ */
/* Status + toast helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Set the header status dot + label.
 * @param {'idle'|'working'|'done'|'error'} kind
 * @param {string} text
 */
function setStatus(kind, text) {
  el.statusDot.className = `status-dot is-${kind}`;
  el.statusText.textContent = text;
}

let toastTimer = null;
/**
 * Flash a transient toast message.
 * @param {string} msg
 * @param {boolean} [isError=false]
 */
function toast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('is-error', !!isError);
  el.toast.hidden = false;
  // force reflow so the transition replays on repeated calls
  void el.toast.offsetWidth;
  el.toast.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('is-show');
    setTimeout(() => { el.toast.hidden = true; }, 220);
  }, 2600);
}

/**
 * Toggle a button's loading state (spinner + disabled).
 * @param {HTMLButtonElement} btn
 * @param {boolean} loading
 */
function setLoading(btn, loading) {
  btn.classList.toggle('is-loading', loading);
  btn.disabled = loading;
}

/* ------------------------------------------------------------------ */
/* Banner (errors)                                                    */
/* ------------------------------------------------------------------ */

function clearBanner() { el.bannerRegion.textContent = ''; }

/**
 * Show a dismissible-style error banner.
 * @param {string} title
 * @param {string} body
 * @param {{label:string, onClick:function}} [action]
 */
function showBanner(title, body, action) {
  clearBanner();
  const banner = document.createElement('div');
  banner.className = 'banner banner-error';

  const t = document.createElement('div');
  t.className = 'banner-title';
  t.textContent = title;
  banner.appendChild(t);

  const b = document.createElement('div');
  b.className = 'banner-body';
  b.textContent = body;
  banner.appendChild(b);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'banner-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    banner.appendChild(btn);
  }
  el.bannerRegion.appendChild(banner);
}

/**
 * Map a protocol error string to friendly banner copy.
 * @param {string} error
 */
function bannerForError(error) {
  if (error === 'NO_API_KEY') {
    showBanner(
      'API key needed',
      'Add your Anthropic API key in settings to generate answers. Your key stays on this device.',
      { label: 'Open settings', onClick: openOptions },
    );
    return;
  }
  showBanner('Something went wrong', String(error || 'Unknown error.'));
}

/* ------------------------------------------------------------------ */
/* Messaging helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Query the active tab in the current window.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (err) {
    console.warn('[LaunchPad] tabs.query failed', err);
    return null;
  }
}

/**
 * Send a message to the content script of a tab. Rejects if no content
 * script is present (e.g. chrome:// pages) so callers can show a hint.
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Send a message to the background service worker.
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}

function openOptions() {
  try { chrome.runtime.openOptionsPage(); }
  catch (err) { console.warn('[LaunchPad] openOptionsPage failed', err); }
}

/* ------------------------------------------------------------------ */
/* Scan & Generate                                                    */
/* ------------------------------------------------------------------ */

async function onScanGenerate() {
  if (state.busy) return;
  state.busy = true;
  clearBanner();
  el.fillResult.hidden = true;
  setLoading(el.scanBtn, true);
  setStatus('working', 'Scanning page…');

  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      throw { friendly: 'Could not find the active tab. Focus a web page and try again.' };
    }

    // --- Scan the page's form via the content script ---
    let scan;
    try {
      const res = await sendToTab(tab.id, { type: 'SCAN_FORM' });
      if (!res || !res.ok) throw { friendly: res && res.error ? String(res.error) : 'Scan failed.' };
      scan = res.data;
    } catch (err) {
      // No content script injected (chrome://, PDF viewer, web store, etc.)
      if (err && err.friendly) throw err;
      throw {
        friendly: "This page can't be scanned. Open a startup-benefit application " +
          '(a normal website with a form) and try again.',
      };
    }

    state.scan = scan;
    const fieldCount = (scan.fields || []).length;
    el.scanMeta.hidden = false;
    el.scanMeta.textContent = `${fieldCount} field${fieldCount === 1 ? '' : 's'} found · ${hostOf(scan.url)}`;

    if (fieldCount === 0) {
      setStatus('done', 'No fields');
      state.items = [];
      renderAnswers();
      toast('No fillable fields found on this page.');
      return;
    }

    // --- Ask the background worker to generate answers ---
    setStatus('working', 'Generating answers…');
    const gen = await sendToBackground({
      type: 'GENERATE_ANSWERS',
      payload: { url: scan.url, title: scan.title, fields: scan.fields },
    });

    if (!gen || !gen.ok) {
      const error = gen ? gen.error : 'GENERATION_FAILED';
      setStatus('error', 'Error');
      bannerForError(error);
      return;
    }

    buildItems(scan.fields, gen.data.answers || []);
    renderAnswers();
    const missingCount = state.items.filter((i) => i.missing).length;
    setStatus('done', missingCount ? `Ready · ${missingCount} to review` : 'Ready to fill');
  } catch (err) {
    console.warn('[LaunchPad] scan/generate error', err);
    setStatus('error', 'Error');
    showBanner('Scan failed', (err && err.friendly) || 'Unexpected error. Please try again.');
  } finally {
    setLoading(el.scanBtn, false);
    state.busy = false;
  }
}

/**
 * Merge fields with generated answers into render items.
 * @param {Array} fields
 * @param {Array} answers
 */
function buildItems(fields, answers) {
  const byFid = new Map();
  answers.forEach((a) => { if (a && a.fid) byFid.set(a.fid, a); });

  state.items = fields.map((f) => {
    const a = byFid.get(f.fid) || {};
    const missing = a.missing === true || a.value == null || a.value === '';
    return {
      fid: f.fid,
      label: f.label || '(unlabeled field)',
      kind: f.kind || 'text',
      value: missing ? (a.value || '[MISSING: ask user]') : String(a.value),
      note: a.note || '',
      missing,
      confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'low',
    };
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

function renderAnswers() {
  el.answers.textContent = '';
  const has = state.items.length > 0;
  el.emptyState.hidden = has;
  el.fillBtn.disabled = !has;

  state.items.forEach((item) => el.answers.appendChild(buildCard(item)));
}

/**
 * Build one answer card. All page-derived text uses textContent.
 * @param {Item} item
 * @returns {HTMLElement}
 */
function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'card' + (item.missing ? ' is-missing' : '');
  card.dataset.fid = item.fid;

  // Head: label + chips
  const head = document.createElement('div');
  head.className = 'card-head';

  const labelWrap = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'card-label';
  label.textContent = item.label;
  labelWrap.appendChild(label);
  const kind = document.createElement('span');
  kind.className = 'card-kind';
  kind.textContent = item.kind;
  labelWrap.appendChild(kind);
  head.appendChild(labelWrap);

  const chips = document.createElement('div');
  chips.className = 'chips';
  const missingChip = document.createElement('span');
  missingChip.className = 'chip chip-missing';
  missingChip.textContent = 'MISSING';
  missingChip.hidden = !item.missing;
  chips.appendChild(missingChip);
  const confChip = document.createElement('span');
  confChip.className = `chip chip-conf-${item.confidence}`;
  confChip.textContent = item.confidence;
  chips.appendChild(confChip);
  head.appendChild(chips);
  card.appendChild(head);

  // Editable value
  const fieldWrap = document.createElement('div');
  fieldWrap.className = 'card-field';
  const ta = document.createElement('textarea');
  ta.className = 'card-value';
  ta.rows = 1;
  ta.value = item.value;
  ta.setAttribute('aria-label', `Answer for ${item.label}`);
  ta.spellcheck = true;
  ta.addEventListener('input', () => onEdit(item, ta, card, missingChip));
  fieldWrap.appendChild(ta);
  card.appendChild(fieldWrap);

  // Foot: note + copy
  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const note = document.createElement('div');
  note.className = 'card-note';
  note.textContent = item.note;
  foot.appendChild(note);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'card-copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => onCopy(item, ta, copy));
  foot.appendChild(copy);
  card.appendChild(foot);

  // Auto-grow once the card is in the DOM.
  requestAnimationFrame(() => autoGrow(ta));
  return card;
}

/**
 * Grow a textarea to fit its content.
 * @param {HTMLTextAreaElement} ta
 */
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

/**
 * Handle an inline edit: update state, auto-grow, clear missing state.
 * @param {Item} item
 * @param {HTMLTextAreaElement} ta
 * @param {HTMLElement} card
 * @param {HTMLElement} missingChip
 */
function onEdit(item, ta, card, missingChip) {
  item.value = ta.value;
  autoGrow(ta);
  // An edit resolves a missing answer — it becomes fillable.
  if (item.missing) {
    item.missing = false;
    card.classList.remove('is-missing');
    missingChip.hidden = true;
    const remaining = state.items.filter((i) => i.missing).length;
    setStatus('done', remaining ? `Ready · ${remaining} to review` : 'Ready to fill');
  }
}

/**
 * Copy a card's current value to the clipboard.
 * @param {Item} item
 * @param {HTMLTextAreaElement} ta
 * @param {HTMLButtonElement} btn
 */
async function onCopy(item, ta, btn) {
  try {
    await navigator.clipboard.writeText(ta.value);
    btn.textContent = 'Copied';
    btn.classList.add('is-copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('is-copied');
    }, 1400);
  } catch (err) {
    console.warn('[LaunchPad] clipboard failed', err);
    toast('Could not copy to clipboard.', true);
  }
}

/* ------------------------------------------------------------------ */
/* Fill page                                                          */
/* ------------------------------------------------------------------ */

async function onFill() {
  if (state.busy) return;
  if (!state.items.length) return;
  state.busy = true;
  clearBanner();
  setLoading(el.fillBtn, true);
  setStatus('working', 'Filling page…');
  el.fillResult.hidden = true;

  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      throw { friendly: 'Could not find the active tab.' };
    }

    // Include every non-missing answer (an edit clears the missing flag),
    // using the CURRENT edited value from state.
    const answers = state.items
      .filter((i) => !i.missing)
      .map((i) => ({ fid: i.fid, value: i.value }));

    if (!answers.length) {
      setStatus('done', 'Nothing to fill');
      toast('All answers are still marked missing — edit them first.');
      return;
    }

    let res;
    try {
      res = await sendToTab(tab.id, { type: 'FILL_FIELDS', payload: { answers } });
    } catch (err) {
      throw { friendly: 'The page is no longer reachable. Re-scan and try again.' };
    }

    if (!res || !res.ok) {
      throw { friendly: res && res.error ? String(res.error) : 'Fill failed.' };
    }

    renderFillResult(res.data, answers.length);
    const filled = (res.data.filled || []).length;
    const total = answers.length;
    setStatus(filled === total ? 'done' : 'error', `${filled}/${total} filled`);
  } catch (err) {
    console.warn('[LaunchPad] fill error', err);
    setStatus('error', 'Error');
    showBanner('Fill failed', (err && err.friendly) || 'Unexpected error while filling.');
  } finally {
    setLoading(el.fillBtn, false);
    state.busy = false;
  }
}

/**
 * Render the "X/Y filled" summary plus any failure reasons.
 * @param {{filled:string[], failed:{fid:string, reason:string}[]}} data
 * @param {number} attempted
 */
function renderFillResult(data, attempted) {
  const filled = (data.filled || []).length;
  const failed = data.failed || [];
  el.fillResult.textContent = '';

  const summary = document.createElement('div');
  summary.className = 'fill-summary';
  const okSpan = document.createElement('span');
  okSpan.className = 'ok';
  okSpan.textContent = `${filled}/${attempted}`;
  summary.appendChild(okSpan);
  summary.appendChild(document.createTextNode(' fields filled'));
  el.fillResult.appendChild(summary);

  if (failed.length) {
    const list = document.createElement('ul');
    list.className = 'fill-fails';
    failed.forEach((f) => {
      const li = document.createElement('li');
      const label = labelForFid(f.fid);
      const b = document.createElement('b');
      b.textContent = label;
      li.appendChild(b);
      li.appendChild(document.createTextNode(` — ${f.reason || 'could not fill'}`));
      list.appendChild(li);
    });
    el.fillResult.appendChild(list);
  }

  el.fillResult.hidden = false;
}

/**
 * Look up a field label by fid for the failure list.
 * @param {string} fid
 * @returns {string}
 */
function labelForFid(fid) {
  const item = state.items.find((i) => i.fid === fid);
  return item ? item.label : fid;
}

/* ------------------------------------------------------------------ */
/* Toolbar: model badge, sync, settings                              */
/* ------------------------------------------------------------------ */

async function loadModelBadge() {
  try {
    const { model } = await chrome.storage.local.get('model');
    el.modelBadge.textContent = MODEL_LABELS[model] || (model ? String(model) : 'No model');
  } catch (err) {
    console.warn('[LaunchPad] load model failed', err);
    el.modelBadge.textContent = 'Model';
  }
}

async function onSyncProfile() {
  if (state.busy) return;
  el.syncBtn.disabled = true;
  try {
    const res = await sendToBackground({ type: 'SYNC_PROFILE' });
    if (res && res.ok) {
      const name = res.data && res.data.basic && res.data.basic.startupName;
      toast(name ? `Profile synced · ${name}` : 'Profile synced from LaunchPad.');
    } else {
      toast((res && res.error) || 'Could not reach LaunchPad (localhost:3000).', true);
    }
  } catch (err) {
    console.warn('[LaunchPad] sync failed', err);
    toast('Sync failed — is LaunchPad running on port 3000?', true);
  } finally {
    el.syncBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

/**
 * Extract a host from a URL for display; safe on malformed input.
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try { return new URL(url).host; }
  catch { return url || ''; }
}

/* ------------------------------------------------------------------ */
/* Init                                                               */
/* ------------------------------------------------------------------ */

function init() {
  cacheEls();
  setStatus('idle', 'Idle');
  loadModelBadge();

  el.scanBtn.addEventListener('click', onScanGenerate);
  el.fillBtn.addEventListener('click', onFill);
  el.syncBtn.addEventListener('click', onSyncProfile);
  el.settingsBtn.addEventListener('click', openOptions);

  // Keep the model badge fresh if the user changes it in options.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.model) loadModelBadge();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
