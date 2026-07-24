/**
 * LaunchPad Agent — background service worker (Agent A).
 *
 * Responsibilities:
 *  - Route runtime messages: GENERATE_ANSWERS, SYNC_PROFILE, TEST_KEY.
 *  - Own the Anthropic Messages API client (headers, timeout, retry, error mapping).
 *  - Read the API key / profile from chrome.storage.local (never log the key).
 *  - Append each generation run to a capped history list.
 *  - Configure the side panel to open on action-icon click.
 *
 * Hard rules enforced here:
 *  - API key lives only in chrome.storage.local and is sent nowhere except
 *    https://api.anthropic.com.
 *  - No external dependencies; vanilla ES2022 module.
 *
 * @module background
 */

import { buildSystemPrompt, buildUserPrompt, parseAnswers, MODELS } from './prompts.js';

/** Anthropic Messages API endpoint. */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/** Anthropic API version header value. */
const ANTHROPIC_VERSION = '2023-06-01';
/** LaunchPad local profile endpoint. */
const LAUNCHPAD_PROFILE_URL = 'http://localhost:3000/api/profile';
/** Request timeout for Anthropic calls (ms). */
const API_TIMEOUT_MS = 60_000;
/** Request timeout for the local LaunchPad server (ms). */
const SYNC_TIMEOUT_MS = 5_000;
/** Backoff before the single retry on 429/5xx (ms). */
const RETRY_BACKOFF_MS = 2_000;
/** Maximum runs kept in history. */
const HISTORY_CAP = 20;
/** max_tokens for a real answer-generation call. */
const MAX_TOKENS_GENERATE = 4000;

/** Default model when none is stored or the stored one is unknown. */
const DEFAULT_MODEL = MODELS && MODELS.length ? MODELS[0] : 'claude-opus-4-8';

// ---------------------------------------------------------------------------
// Install hook
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn('setPanelBehavior failed:', friendlyMessage(err)));
  } catch (err) {
    console.warn('setPanelBehavior threw:', friendlyMessage(err));
  }
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Sleep for the given duration.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Produce a safe, non-sensitive message string from any thrown value.
 * Never includes storage contents or the API key.
 * @param {unknown} err - Caught value.
 * @returns {string}
 */
function friendlyMessage(err) {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

/**
 * Read a value from chrome.storage.local as a Promise.
 * @param {string|string[]|Object} keys - Storage keys to fetch.
 * @returns {Promise<Object>} Resolved storage object.
 */
function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (items) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(items || {});
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Write values to chrome.storage.local as a Promise (merges by key).
 * @param {Object} items - Key/value pairs to store.
 * @returns {Promise<void>}
 */
function storageSet(items) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(items, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status / network condition to a friendly, user-visible string.
 * @param {number} status - HTTP status code (0 for network/abort).
 * @param {string} [detail] - Optional extra context (never contains the key).
 * @returns {string}
 */
function mapHttpError(status, detail) {
  switch (true) {
    case status === 401:
      return 'Invalid API key';
    case status === 403:
      return 'Access forbidden — check your API key permissions';
    case status === 429:
      return 'Rate limited — try again';
    case status >= 500:
      return 'Anthropic service error — try again';
    case status === 400:
      return detail ? `Request rejected: ${detail}` : 'Request rejected by the API';
    default:
      return detail || `Request failed (HTTP ${status})`;
  }
}

/**
 * Whether an HTTP status is worth one retry.
 * @param {number} status - HTTP status code.
 * @returns {boolean}
 */
function isRetryable(status) {
  return status === 429 || status >= 500;
}

/**
 * Perform a single POST to the Anthropic Messages API with a 60s timeout.
 * Does not retry. Throws an Error on network/abort; returns the parsed
 * response with an `ok` flag and status otherwise.
 *
 * @param {string} apiKey - Anthropic API key (never logged).
 * @param {Object} body - Request body (model, max_tokens, system, messages).
 * @returns {Promise<{ok: boolean, status: number, json: any, text: string}>}
 */
async function anthropicRequestOnce(apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the Anthropic Messages API with one retry on 429/5xx (2s backoff)
 * and a 60s per-attempt timeout. Returns friendly errors instead of raw ones.
 *
 * @param {string} apiKey - Anthropic API key (never logged).
 * @param {Object} body - Request body.
 * @returns {Promise<{ok: true, json: any} | {ok: false, error: string}>}
 */
async function callAnthropic(apiKey, body) {
  let lastStatus = 0;
  let lastDetail = '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await anthropicRequestOnce(apiKey, body);
      if (result.ok) {
        return { ok: true, json: result.json };
      }

      lastStatus = result.status;
      lastDetail =
        (result.json && result.json.error && typeof result.json.error.message === 'string'
          ? result.json.error.message
          : '') || '';

      if (attempt === 0 && isRetryable(result.status)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return { ok: false, error: mapHttpError(result.status, lastDetail) };
    } catch (err) {
      // Network failure or abort (timeout).
      const aborted = err && typeof err === 'object' && err.name === 'AbortError';
      if (aborted) {
        // A timeout is retried once like a transient failure.
        if (attempt === 0) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        return { ok: false, error: 'Request timed out — try again' };
      }
      // Generic network error.
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return { ok: false, error: 'Network error — offline?' };
    }
  }

  return { ok: false, error: mapHttpError(lastStatus, lastDetail) };
}

/**
 * Generate via a Kiro model proxied through the local LaunchPad server
 * (POST /api/agent-generate). The ksk_ key stays server-side in .env.
 * @param {string} system - System prompt.
 * @param {string} user - User prompt.
 * @param {string} modelId - e.g. "kiro/claude-haiku-4.5".
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
async function callKiroViaServer(system, user, modelId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS * 2);
  try {
    const res = await fetch('http://localhost:3000/api/agent-generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system, user, model: modelId }),
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok || !json || !json.ok) {
      const detail = json && json.error ? json.error : `HTTP ${res.status}`;
      return {
        ok: false,
        error: `Kiro via LaunchPad server failed: ${detail}. Is "npm start" running?`,
      };
    }
    return { ok: true, text: (json.data && json.data.text) || '' };
  } catch (err) {
    const aborted = err && typeof err === 'object' && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? 'Kiro request timed out'
        : 'LaunchPad server not reachable on localhost:3000 — run "npm start"',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the first text block from an Anthropic Messages API response.
 * @param {any} json - Parsed API response.
 * @returns {string} Raw text (empty string if none found).
 */
function extractRawText(json) {
  if (!json || !Array.isArray(json.content)) {
    return '';
  }
  const block = json.content.find(
    (b) => b && b.type === 'text' && typeof b.text === 'string',
  );
  return block ? block.text : '';
}

/**
 * Resolve the model id to use, falling back to the default when the stored
 * value is missing or not a recognised model.
 * @param {unknown} stored - Value read from storage.
 * @returns {string}
 */
function resolveModel(stored) {
  if (typeof stored === 'string' && MODELS.includes(stored)) {
    return stored;
  }
  return DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Append a run summary to history (newest first), capped at HISTORY_CAP.
 * Best-effort: failures are swallowed so they never break a generation.
 * @param {{host: string, fieldsFilled: number, missing: number}} entry - Run summary.
 * @returns {Promise<void>}
 */
async function appendHistory(entry) {
  try {
    const { history } = await storageGet('history');
    const list = Array.isArray(history) ? history : [];
    const record = {
      ts: Date.now(),
      host: entry.host,
      fieldsFilled: entry.fieldsFilled,
      missing: entry.missing,
    };
    const next = [record, ...list].slice(0, HISTORY_CAP);
    await storageSet({ history: next });
  } catch (err) {
    console.warn('history append failed:', friendlyMessage(err));
  }
}

/**
 * Safely derive the host from a URL string.
 * @param {string} url - Page URL.
 * @returns {string}
 */
function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Handle GENERATE_ANSWERS: load key + profile, call Anthropic, parse answers.
 * @param {{url: string, title: string, fields: Array}} payload - Scan payload.
 * @returns {Promise<{ok: true, data: {answers: Array, mode: string}} | {ok: false, error: string}>}
 */
async function handleGenerateAnswers(payload) {
  try {
    const scan = payload || {};
    const fields = Array.isArray(scan.fields) ? scan.fields : [];

    const { apiKey, model, profile } = await storageGet(['apiKey', 'model', 'profile']);

    const modelId = resolveModel(model);
    const isKiro = modelId.startsWith('kiro/');

    // Kiro models are served by the local LaunchPad server (the ksk_ key
    // lives in the server's .env, never in the browser). Anthropic models
    // need the key stored in extension settings.
    if (!isKiro && (!apiKey || typeof apiKey !== 'string')) {
      return { ok: false, error: 'NO_API_KEY' };
    }

    // Pass the page URL so prompts.js can select program-specific hints
    // (AWS Activate, MongoDB for Startups, etc.) instead of generic guidance.
    const system = buildSystemPrompt(profile || {}, scan.url || '');
    const userContent = buildUserPrompt({
      url: scan.url || '',
      title: scan.title || '',
      fields,
    });

    let rawText = '';
    if (isKiro) {
      const kiroResult = await callKiroViaServer(system, userContent, modelId);
      if (!kiroResult.ok) {
        return { ok: false, error: kiroResult.error };
      }
      rawText = kiroResult.text;
    } else {
      const body = {
        model: modelId,
        max_tokens: MAX_TOKENS_GENERATE,
        system,
        messages: [{ role: 'user', content: userContent }],
      };

      const apiResult = await callAnthropic(apiKey, body);
      if (!apiResult.ok) {
        return { ok: false, error: apiResult.error };
      }
      rawText = extractRawText(apiResult.json);
    }
    const parsed = parseAnswers(rawText, fields);
    if (parsed && parsed.error) {
      return { ok: false, error: `Could not read the AI response: ${parsed.error}` };
    }

    const answers = parsed && Array.isArray(parsed.answers) ? parsed.answers : [];
    const missingCount = answers.filter((a) => a && a.missing).length;

    await appendHistory({
      host: hostFromUrl(scan.url || ''),
      fieldsFilled: answers.length - missingCount,
      missing: missingCount,
    });

    return { ok: true, data: { answers, mode: modelId } };
  } catch (err) {
    return { ok: false, error: friendlyMessage(err) || 'Unexpected error generating answers' };
  }
}

/**
 * Handle SYNC_PROFILE: fetch the LaunchPad server profile, validate, merge-save.
 * @returns {Promise<{ok: true, data: Object} | {ok: false, error: string}>}
 */
async function handleSyncProfile() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(LAUNCHPAD_PROFILE_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, error: 'LaunchPad server not reachable on localhost:3000' };
    }

    let incoming = null;
    try {
      incoming = await res.json();
    } catch {
      return { ok: false, error: 'LaunchPad server returned invalid data' };
    }

    if (!incoming || typeof incoming !== 'object' || !incoming.basic) {
      return { ok: false, error: 'LaunchPad server returned an unexpected profile shape' };
    }

    // Merge with any existing profile so we never clobber locally-set fields
    // that the server may omit; server values win where present.
    const { profile } = await storageGet('profile');
    const existing = profile && typeof profile === 'object' ? profile : {};
    const merged = {
      ...existing,
      ...incoming,
      basic: { ...(existing.basic || {}), ...(incoming.basic || {}) },
      extended: { ...(existing.extended || {}), ...(incoming.extended || {}) },
    };

    await storageSet({ profile: merged });
    return { ok: true, data: merged };
  } catch (err) {
    const aborted = err && typeof err === 'object' && err.name === 'AbortError';
    if (aborted) {
      return { ok: false, error: 'LaunchPad server not reachable on localhost:3000' };
    }
    return { ok: false, error: 'LaunchPad server not reachable on localhost:3000' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handle TEST_KEY: minimal 1-token ping to the Messages API.
 * @returns {Promise<{ok: true, data: {valid: true}} | {ok: false, error: string}>}
 */
async function handleTestKey() {
  try {
    const { apiKey, model } = await storageGet(['apiKey', 'model']);
    if (!apiKey || typeof apiKey !== 'string') {
      return { ok: false, error: 'NO_API_KEY' };
    }

    const body = {
      model: resolveModel(model),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    };

    const apiResult = await callAnthropic(apiKey, body);
    if (!apiResult.ok) {
      return { ok: false, error: apiResult.error };
    }
    return { ok: true, data: { valid: true } };
  } catch (err) {
    return { ok: false, error: friendlyMessage(err) || 'Unexpected error testing key' };
  }
}

// ---------------------------------------------------------------------------
// One-click autofill from the LaunchPad dashboard (FILL_PROGRAM)
// ---------------------------------------------------------------------------

/** Max time to wait for the application tab to finish loading (ms). */
const AUTOFILL_LOAD_TIMEOUT_MS = 30_000;
/** Extra settle time after 'complete' for JS-rendered forms (ms). */
const AUTOFILL_SETTLE_MS = 2_000;
/** SCAN_FORM attempts on the fresh tab (content script may not be ready). */
const SCAN_RETRIES = 4;
/** Gap between scan attempts (ms). */
const SCAN_RETRY_GAP_MS = 1_500;

/**
 * Promise wrapper around chrome.tabs.sendMessage.
 * @param {number} tabId - Target tab.
 * @param {Object} message - Message to send.
 * @returns {Promise<any>} Resolves with the response; rejects on lastError.
 */
function tabsSend(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Resolve when the tab reports status 'complete' (or on timeout — best effort).
 * @param {number} tabId - Tab to watch.
 * @param {number} timeoutMs - Max wait.
 * @returns {Promise<void>}
 */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    /** @param {number} id @param {{status?: string}} info */
    const listener = (id, info) => {
      if (id === tabId && info && info.status === 'complete') {
        finish();
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (_e) {
        /* ignore */
      }
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // The tab may already be complete before the listener attached.
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.status === 'complete') {
          finish();
        }
      });
    } catch (_e) {
      /* ignore */
    }
    setTimeout(finish, timeoutMs);
  });
}

/**
 * SCAN_FORM with retries — the content script needs a moment on fresh tabs.
 * @param {number} tabId - Application tab.
 * @returns {Promise<{url: string, title: string, fields: Array}>}
 */
async function scanWithRetry(tabId) {
  let lastError = 'scan failed';
  for (let attempt = 0; attempt < SCAN_RETRIES; attempt += 1) {
    try {
      const res = await tabsSend(tabId, { type: 'SCAN_FORM' });
      if (res && res.ok && res.data && Array.isArray(res.data.fields)) {
        if (res.data.fields.length > 0 || attempt === SCAN_RETRIES - 1) {
          return res.data;
        }
        lastError = 'no form fields found yet';
      } else {
        lastError = (res && res.error) || 'scan failed';
      }
    } catch (err) {
      lastError = friendlyMessage(err);
    }
    await sleep(SCAN_RETRY_GAP_MS);
  }
  throw new Error(lastError);
}

/**
 * Report autofill progress back to the dashboard tab (relayed to the page
 * by the content-script bridge). Best-effort — failures are swallowed.
 * @param {number|undefined} dashboardTabId - Tab hosting the dashboard.
 * @param {Object} payload - FILL_RESULT payload.
 */
function reportToDashboard(dashboardTabId, payload) {
  if (typeof dashboardTabId !== 'number') {
    return;
  }
  try {
    chrome.tabs.sendMessage(dashboardTabId, { type: 'FILL_RESULT', payload }, () => {
      void chrome.runtime.lastError; // dashboard tab may be gone — fine
    });
  } catch (_e) {
    /* ignore */
  }
}

/**
 * The full one-click flow: open the application page, wait, scan, generate,
 * fill (skipping missing answers), then report the outcome to the dashboard.
 * Runs detached from the FILL_PROGRAM response.
 * @param {string} applyUrl - Validated https application URL.
 * @param {string} programId - Program id for dashboard correlation.
 * @param {number|undefined} dashboardTabId - Where to send FILL_RESULT.
 * @returns {Promise<void>}
 */
async function runAutofill(applyUrl, programId, dashboardTabId) {
  const base = { programId, host: hostFromUrl(applyUrl) };
  try {
    const tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({ url: applyUrl, active: true }, (t) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else resolve(t);
      });
    });

    // Side panel so the user can watch/edit — needs a user gesture on some
    // Chrome versions, so failure here is non-fatal.
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (_e) {
      /* no gesture context — fine */
    }

    await waitForTabComplete(tab.id, AUTOFILL_LOAD_TIMEOUT_MS);
    await sleep(AUTOFILL_SETTLE_MS);

    const scan = await scanWithRetry(tab.id);
    if (!scan.fields.length) {
      reportToDashboard(dashboardTabId, {
        ...base,
        filled: 0,
        failed: 0,
        missing: 0,
        error: 'No form found on the page — it may need a login first',
      });
      return;
    }

    const gen = await handleGenerateAnswers(scan);
    if (!gen.ok) {
      const msg =
        gen.error === 'NO_API_KEY'
          ? 'No API key configured — open the extension settings'
          : gen.error;
      reportToDashboard(dashboardTabId, { ...base, filled: 0, failed: 0, missing: 0, error: msg });
      return;
    }

    const answers = gen.data.answers || [];
    const missing = answers.filter((a) => a && a.missing);
    const fillable = answers
      .filter((a) => a && !a.missing)
      .map((a) => ({ fid: a.fid, value: a.value }));

    let filled = [];
    let failed = [];
    if (fillable.length) {
      const fillRes = await tabsSend(tab.id, {
        type: 'FILL_FIELDS',
        payload: { answers: fillable },
      });
      if (fillRes && fillRes.ok && fillRes.data) {
        filled = fillRes.data.filled || [];
        failed = fillRes.data.failed || [];
      }
    }

    reportToDashboard(dashboardTabId, {
      ...base,
      filled: filled.length,
      failed: failed.length,
      missing: missing.length,
      error: null,
    });
  } catch (err) {
    reportToDashboard(dashboardTabId, {
      ...base,
      filled: 0,
      failed: 0,
      missing: 0,
      error: friendlyMessage(err) || 'Autofill failed',
    });
  }
}

/**
 * Handle FILL_PROGRAM from the dashboard bridge: validate the URL, kick off
 * the detached autofill run, and acknowledge immediately.
 * @param {{applyUrl?: string, programId?: string}} payload - Bridge payload.
 * @param {number|undefined} dashboardTabId - Sender tab (the dashboard).
 * @returns {{ok: true, data: {started: true}} | {ok: false, error: string}}
 */
function handleFillProgram(payload, dashboardTabId) {
  const applyUrl = payload && typeof payload.applyUrl === 'string' ? payload.applyUrl : '';
  const programId = payload && typeof payload.programId === 'string' ? payload.programId : '';

  let parsed;
  try {
    parsed = new URL(applyUrl);
  } catch {
    return { ok: false, error: 'Invalid application URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https application URLs are allowed' };
  }

  // Detached — the dashboard gets progress via FILL_RESULT.
  runAutofill(applyUrl, programId, dashboardTabId).catch(() => {
    /* already reported inside */
  });

  return { ok: true, data: { started: true } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Dispatch a message to its handler.
 * @param {{type: string, payload?: any}} message - Incoming message.
 * @returns {Promise<Object>} Handler response ({ok:true,data} | {ok:false,error}).
 */
async function routeMessage(message) {
  const type = message && message.type;
  switch (type) {
    case 'GENERATE_ANSWERS':
      return handleGenerateAnswers(message.payload);
    case 'SYNC_PROFILE':
      return handleSyncProfile();
    case 'TEST_KEY':
      return handleTestKey();
    default:
      return { ok: false, error: `Unknown message type: ${String(type)}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // FILL_PROGRAM is synchronous-ack: validate, start detached run, respond.
  if (message && message.type === 'FILL_PROGRAM') {
    const dashboardTabId = sender && sender.tab ? sender.tab.id : undefined;
    try {
      sendResponse(handleFillProgram(message.payload, dashboardTabId));
    } catch (err) {
      sendResponse({ ok: false, error: friendlyMessage(err) });
    }
    return false;
  }

  const handled =
    message &&
    (message.type === 'GENERATE_ANSWERS' ||
      message.type === 'SYNC_PROFILE' ||
      message.type === 'TEST_KEY');

  if (!handled) {
    // Not ours (e.g. SCAN_FORM / FILL_FIELDS go to content.js). Ignore.
    return false;
  }

  routeMessage(message)
    .then((response) => sendResponse(response))
    .catch((err) => sendResponse({ ok: false, error: friendlyMessage(err) }));

  // Keep the message channel open for the async sendResponse above.
  return true;
});
