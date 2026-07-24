/**
 * LaunchPad Agent — options page controller.
 *
 * Owns three storage keys directly (apiKey, model, profile) and delegates
 * network work (TEST_KEY, SYNC_PROFILE) to the background service worker via
 * the {type, payload} → {ok, data|error} message protocol.
 *
 * Storage rule: every write is read-merge-write — we read current storage,
 * merge our change in, and set only the touched top-level keys so sibling
 * keys (e.g. history) are never clobbered.
 */

'use strict';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/**
 * The four selectable models. `id` values MUST match the Anthropic model
 * strings exactly — they are sent verbatim to the API.
 * @type {ReadonlyArray<{id: string, name: string, desc: string}>}
 */
const MODELS = [
  { id: 'kiro/claude-haiku-4.5', name: 'Kiro · Haiku 4.5', desc: 'Cheap & balanced — uses your Kiro subscription via the LaunchPad server (no Anthropic key needed; requires "npm start" running).' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', desc: 'Best default — balanced quality and speed. Needs Anthropic API key.' },
  { id: 'claude-fable-5', name: 'Fable 5', desc: 'Most capable — for the toughest applications. Needs Anthropic API key.' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Fast — quick turnaround, strong quality. Needs Anthropic API key.' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'Cheapest Anthropic option — lightweight and economical.' },
];

const DEFAULT_MODEL = 'kiro/claude-haiku-4.5';

/**
 * Profile field definitions, in render order. `group` maps to the two
 * fieldsets; `type` selects the input control.
 * @type {ReadonlyArray<{key: string, label: string, group: 'basic'|'extended', type: string}>}
 */
const PROFILE_FIELDS = [
  // Basic (6)
  { key: 'startupName', label: 'Startup name', group: 'basic', type: 'text' },
  { key: 'website', label: 'Website', group: 'basic', type: 'url' },
  { key: 'email', label: 'Email', group: 'basic', type: 'email' },
  { key: 'description', label: 'Description', group: 'basic', type: 'textarea' },
  { key: 'country', label: 'Country', group: 'basic', type: 'text' },
  { key: 'foundedYear', label: 'Founded year', group: 'basic', type: 'text' },
  // Extended (11)
  { key: 'stage', label: 'Stage', group: 'extended', type: 'text' },
  { key: 'fundingRaised', label: 'Funding raised', group: 'extended', type: 'textarea' },
  { key: 'teamSize', label: 'Team size', group: 'extended', type: 'text' },
  { key: 'industry', label: 'Industry', group: 'extended', type: 'text' },
  { key: 'linkedin', label: 'LinkedIn', group: 'extended', type: 'url' },
  { key: 'pitch', label: 'Pitch', group: 'extended', type: 'textarea' },
  { key: 'techStack', label: 'Tech stack', group: 'extended', type: 'textarea' },
  { key: 'monthlyCloudSpend', label: 'Monthly cloud spend', group: 'extended', type: 'text' },
  { key: 'incorporated', label: 'Incorporated', group: 'extended', type: 'text' },
  { key: 'founderName', label: 'Founder name', group: 'extended', type: 'text' },
  { key: 'founderRole', label: 'Founder role', group: 'extended', type: 'text' },
];

/** @type {number} How long a danger button stays "armed" before reverting. */
const CONFIRM_MS = 3000;

/* ------------------------------------------------------------------ *
 * Small DOM helpers
 * ------------------------------------------------------------------ */

/** @param {string} id @returns {HTMLElement} */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Create an element with attributes and children.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

/* ------------------------------------------------------------------ *
 * Storage (read-merge-write) & messaging
 * ------------------------------------------------------------------ */

/**
 * Read the entire local storage bag.
 * @returns {Promise<Record<string, any>>}
 */
async function readAll() {
  try {
    return await chrome.storage.local.get(null);
  } catch (err) {
    console.error('[options] storage.get failed', err);
    return {};
  }
}

/**
 * Read-merge-write: reads current storage, applies `patch` over the top-level
 * keys it names, and writes back only those keys. Sibling keys are untouched.
 * @param {Record<string, any>} patch
 * @returns {Promise<void>}
 */
async function mergeWrite(patch) {
  const current = await readAll();
  /** @type {Record<string, any>} */
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    // Deep-merge the profile object so a partial update never drops the other half.
    if (key === 'profile' && current.profile && typeof value === 'object') {
      next.profile = {
        basic: { ...(current.profile.basic || {}), ...(value.basic || {}) },
        extended: { ...(current.profile.extended || {}), ...(value.extended || {}) },
      };
    } else {
      next[key] = value;
    }
  }
  await chrome.storage.local.set(next);
}

/**
 * Send a {type, payload} message to the background worker and normalise the
 * response to {ok, data?, error?}. Never throws — transport failures are
 * mapped to {ok:false}.
 * @param {string} type
 * @param {any} [payload]
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function sendMessage(type, payload) {
  try {
    const res = await chrome.runtime.sendMessage({ type, payload });
    if (res && typeof res === 'object' && 'ok' in res) return res;
    return { ok: false, error: 'No response from background.' };
  } catch (err) {
    console.error(`[options] sendMessage(${type}) failed`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

/**
 * Show a bottom-right toast that auto-dismisses.
 * @param {string} message
 * @param {'ok'|'err'} [kind='ok']
 */
function toast(message, kind = 'ok') {
  const node = el('div', { class: `toast ${kind}` });
  node.append(el('span', { class: 'toast-mark' }, [kind === 'ok' ? '✓' : '✗']));
  node.append(document.createTextNode(message));
  $('toasts').append(node);
  window.setTimeout(() => {
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }, 2600);
}

/* ------------------------------------------------------------------ *
 * Section 1 — API key
 * ------------------------------------------------------------------ */

/** @param {string} key @returns {string} masked form like sk-ant-…abcd */
function maskKey(key) {
  const last4 = key.slice(-4);
  return `sk-ant-…${last4}`;
}

/**
 * Toggle between the saved (masked) view and the edit (input) view.
 * @param {boolean} hasKey
 * @param {string} [key]
 */
function renderKeyState(hasKey, key = '') {
  const saved = $('keySaved');
  const edit = $('keyEdit');
  if (hasKey) {
    $('keyMask').textContent = maskKey(key);
    saved.hidden = false;
    edit.hidden = true;
  } else {
    saved.hidden = true;
    edit.hidden = false;
    /** @type {HTMLInputElement} */ ($('apiKey')).value = '';
    setKeyResult('', '');
  }
}

/**
 * Set the inline ✓/✗ result next to the key buttons.
 * @param {string} text
 * @param {''|'ok'|'err'|'pending'} kind
 */
function setKeyResult(text, kind) {
  const node = $('keyResult');
  node.textContent = text;
  node.className = `inline-result${kind ? ' ' + kind : ''}`;
}

/** Wire up the eye toggle, save, test, and replace controls. */
function initKeySection() {
  const input = /** @type {HTMLInputElement} */ ($('apiKey'));

  // Show/hide toggle
  $('keyToggle').addEventListener('click', () => {
    const btn = $('keyToggle');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', showing ? 'Show key' : 'Hide key');
    btn.querySelector('.eye-open').toggleAttribute('hidden', !showing);
    btn.querySelector('.eye-closed').toggleAttribute('hidden', showing);
  });

  // Save
  $('keySave').addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) {
      setKeyResult('Enter a key first', 'err');
      return;
    }
    try {
      await mergeWrite({ apiKey: value });
      renderKeyState(true, value);
      toast('API key saved');
    } catch (err) {
      console.error('[options] save key failed', err);
      toast('Could not save key', 'err');
    }
  });

  // Test — persist any unsaved input first, then ping via background.
  $('keyTest').addEventListener('click', async () => {
    const btn = /** @type {HTMLButtonElement} */ ($('keyTest'));
    const value = input.value.trim();
    try {
      if (value) await mergeWrite({ apiKey: value });
      const { apiKey } = await readAll();
      if (!apiKey) {
        setKeyResult('✗ No key to test', 'err');
        return;
      }
      btn.disabled = true;
      setKeyResult('Testing…', 'pending');
      const res = await sendMessage('TEST_KEY');
      if (res.ok) {
        setKeyResult('✓ Key works', 'ok');
        renderKeyState(true, apiKey);
      } else {
        setKeyResult(`✗ ${res.error || 'Test failed'}`, 'err');
      }
    } catch (err) {
      console.error('[options] test key failed', err);
      setKeyResult('✗ Test failed', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  // Replace — drop back to the edit view.
  $('keyReplace').addEventListener('click', () => {
    renderKeyState(false);
    /** @type {HTMLInputElement} */ ($('apiKey')).focus();
  });
}

/* ------------------------------------------------------------------ *
 * Section 2 — Model
 * ------------------------------------------------------------------ */

/**
 * Render the model radio cards and highlight the selected one.
 * @param {string} selected
 */
function renderModels(selected) {
  const list = $('modelList');
  list.textContent = '';
  for (const m of MODELS) {
    const isSel = m.id === selected;
    const card = el('label', { class: `model-card${isSel ? ' selected' : ''}`, 'data-id': m.id });
    const radio = /** @type {HTMLInputElement} */ (
      el('input', { type: 'radio', name: 'model', value: m.id })
    );
    radio.checked = isSel;
    radio.addEventListener('change', () => selectModel(m.id));

    const info = el('span', { class: 'model-info' }, [
      el('span', { class: 'model-name' }, [m.name]),
      el('span', { class: 'model-id' }, [m.id]),
      el('span', { class: 'model-desc' }, [m.desc]),
    ]);
    card.append(radio, info);
    list.append(card);
  }
}

/**
 * Persist the chosen model and refresh selection styling.
 * @param {string} id
 */
async function selectModel(id) {
  try {
    await mergeWrite({ model: id });
    for (const card of $('modelList').querySelectorAll('.model-card')) {
      card.classList.toggle('selected', card.getAttribute('data-id') === id);
    }
    const chosen = MODELS.find((m) => m.id === id);
    toast(`Model set to ${chosen ? chosen.name : id}`);
  } catch (err) {
    console.error('[options] save model failed', err);
    toast('Could not save model', 'err');
  }
}

/* ------------------------------------------------------------------ *
 * Section 3 — Profile
 * ------------------------------------------------------------------ */

/** Build the profile inputs into their fieldsets (once). */
function buildProfileForm() {
  const basic = $('basicFields');
  const extended = $('extendedFields');
  basic.textContent = '';
  extended.textContent = '';

  for (const f of PROFILE_FIELDS) {
    const wide = f.type === 'textarea';
    const wrap = el('div', { class: `field${wide ? ' wide' : ''}` });
    wrap.append(el('label', { for: `pf-${f.key}` }, [f.label]));

    let control;
    if (f.type === 'textarea') {
      control = el('textarea', { id: `pf-${f.key}`, class: 'field-input', rows: '3' });
    } else {
      control = el('input', { id: `pf-${f.key}`, class: 'field-input', type: f.type });
    }
    control.setAttribute('data-key', f.key);
    control.setAttribute('data-group', f.group);
    wrap.append(control);
    (f.group === 'basic' ? basic : extended).append(wrap);
  }
}

/**
 * Fill the profile inputs from a stored profile object.
 * @param {{basic?: Record<string,string>, extended?: Record<string,string>}} [profile]
 */
function fillProfileForm(profile) {
  const p = profile || {};
  const basic = p.basic || {};
  const extended = p.extended || {};
  for (const f of PROFILE_FIELDS) {
    const control = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (
      document.getElementById(`pf-${f.key}`)
    );
    if (!control) continue;
    const src = f.group === 'basic' ? basic : extended;
    control.value = typeof src[f.key] === 'string' ? src[f.key] : '';
  }
}

/**
 * Collect the current form values into a profile object.
 * @returns {{basic: Record<string,string>, extended: Record<string,string>}}
 */
function collectProfile() {
  /** @type {Record<string,string>} */
  const basic = {};
  /** @type {Record<string,string>} */
  const extended = {};
  for (const f of PROFILE_FIELDS) {
    const control = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (
      document.getElementById(`pf-${f.key}`)
    );
    const value = control ? control.value.trim() : '';
    if (f.group === 'basic') basic[f.key] = value;
    else extended[f.key] = value;
  }
  return { basic, extended };
}

/** Wire the save + sync controls. */
function initProfileSection() {
  $('profileForm').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    try {
      await mergeWrite({ profile: collectProfile() });
      toast('Profile saved');
    } catch (err) {
      console.error('[options] save profile failed', err);
      toast('Could not save profile', 'err');
    }
  });

  $('profileSync').addEventListener('click', async () => {
    const btn = /** @type {HTMLButtonElement} */ ($('profileSync'));
    const result = $('syncResult');
    btn.disabled = true;
    result.textContent = 'Syncing…';
    result.className = 'inline-result pending';
    try {
      const res = await sendMessage('SYNC_PROFILE');
      if (res.ok) {
        // Background may return the profile directly or wrapped in {profile}.
        const profile =
          res.data && res.data.profile ? res.data.profile : res.data;
        fillProfileForm(profile);
        result.textContent = '✓ Synced';
        result.className = 'inline-result ok';
        toast('Profile synced from LaunchPad');
      } else {
        result.textContent = `✗ ${res.error || 'Sync failed'}`;
        result.className = 'inline-result err';
        toast(res.error || 'Sync failed — is LaunchPad running?', 'err');
      }
    } catch (err) {
      console.error('[options] sync failed', err);
      result.textContent = '✗ Sync failed';
      result.className = 'inline-result err';
      toast('Sync failed', 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Section 4 — Danger zone
 * ------------------------------------------------------------------ */

/**
 * Turn a danger button into a two-step confirm: first click arms it as
 * "Really clear?" for CONFIRM_MS, a second click within the window runs `action`.
 * @param {string} btnId
 * @param {string} idleLabel
 * @param {() => Promise<void>} action
 */
function initDangerButton(btnId, idleLabel, action) {
  const btn = /** @type {HTMLButtonElement} */ ($(btnId));
  /** @type {number|undefined} */
  let timer;

  const disarm = () => {
    window.clearTimeout(timer);
    timer = undefined;
    btn.classList.remove('armed');
    btn.textContent = idleLabel;
    btn.dataset.confirm = '0';
  };

  btn.addEventListener('click', async () => {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.classList.add('armed');
      btn.textContent = 'Really clear?';
      timer = window.setTimeout(disarm, CONFIRM_MS);
      return;
    }
    disarm();
    try {
      await action();
    } catch (err) {
      console.error(`[options] ${btnId} action failed`, err);
      toast('Action failed', 'err');
    }
  });
}

/** Wire both danger-zone buttons. */
function initDangerSection() {
  initDangerButton('clearKey', 'Clear API key', async () => {
    await mergeWrite({ apiKey: '' });
    renderKeyState(false);
    toast('API key cleared');
  });

  initDangerButton('clearAll', 'Clear all data', async () => {
    await chrome.storage.local.clear();
    // Reset the UI to defaults.
    renderKeyState(false);
    renderModels(DEFAULT_MODEL);
    fillProfileForm({ basic: {}, extended: {} });
    toast('All data cleared');
  });
}

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */

/** Load stored state and populate every section. */
async function init() {
  buildProfileForm();
  initKeySection();
  initProfileSection();
  initDangerSection();

  try {
    const { apiKey, model, profile } = await readAll();
    renderKeyState(Boolean(apiKey), apiKey || '');
    renderModels(model || DEFAULT_MODEL);
    fillProfileForm(profile);
  } catch (err) {
    console.error('[options] init failed', err);
    renderKeyState(false);
    renderModels(DEFAULT_MODEL);
    toast('Could not load settings', 'err');
  }
}

document.addEventListener('DOMContentLoaded', init);
