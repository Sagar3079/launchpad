/**
 * Live co-browsing via Steel.dev.
 *
 * One Steel session exposes both an interactive live-view URL (embed in an
 * iframe so the HUMAN logs into their own account by hand) and a CDP endpoint
 * (this server attaches Playwright and fills the form in the SAME browser).
 *
 * Hard rules preserved: never submits, never ticks consent/terms, never
 * fabricates (missing facts -> [MISSING: ask user]). The server never sees
 * the user's account password — they type it into the live view themselves.
 *
 * Requires STEEL_API_KEY in the environment. Playwright connects over CDP to
 * Steel's remote browser, so only `playwright-core` is needed (no local
 * browser download).
 */

'use strict';

const kiro = (() => { try { return require('./kiro.js'); } catch { return null; } })();

const STEEL_API_KEY = () => (process.env.STEEL_API_KEY || '').trim();
const STEEL_API = 'https://api.steel.dev/v1';

// In-memory session registry, keyed by app user id. One live session per user.
const sessions = new Map();

function configured() {
  return !!STEEL_API_KEY();
}

async function steelFetch(pathname, options) {
  const res = await fetch(STEEL_API + pathname, {
    ...options,
    headers: {
      'steel-api-key': STEEL_API_KEY(),
      'content-type': 'application/json',
      ...(options && options.headers),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `Steel API ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/**
 * Create a Steel session and return the live-view URL + CDP connect URL.
 * @param {number} userId
 * @returns {Promise<{sessionId:string, liveViewUrl:string}>}
 */
async function startSession(userId) {
  if (!configured()) throw new Error('STEEL_API_KEY not set');
  // Reuse an existing live session for this user if present.
  const existing = sessions.get(userId);
  if (existing) return { sessionId: existing.id, liveViewUrl: existing.liveViewUrl };

  const s = await steelFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ solveCaptcha: false }),
  });

  const id = s.id || s.sessionId;
  const liveViewUrl = s.sessionViewerUrl || s.debugUrl || s.liveViewUrl;
  const wsBase = s.websocketUrl || s.connectUrl || s.wsUrl;
  if (!id || !liveViewUrl || !wsBase) {
    throw new Error('Steel session response missing id / viewer / websocket URL');
  }
  const connectUrl = wsBase.includes('apiKey=')
    ? wsBase
    : `${wsBase}${wsBase.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(STEEL_API_KEY())}`;

  sessions.set(userId, { id, liveViewUrl, connectUrl, createdAt: Date.now() });
  return { sessionId: id, liveViewUrl };
}

/**
 * Release the user's Steel session.
 * @param {number} userId
 */
async function stopSession(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  sessions.delete(userId);
  try { await steelFetch(`/sessions/${s.id}/release`, { method: 'POST' }); } catch { /* best effort */ }
}

// ---- Answer generation (truthful, never fabricate) ----

function buildSystem(profile) {
  return [
    'You fill startup-benefit application forms with TRUTHFUL answers drawn only from the profile below.',
    'Rules:',
    '1. Use ONLY facts in the profile. Never invent dates, revenue, funding, employee counts, IDs, addresses, or phone numbers.',
    '2. If a field is not in the profile but can be honestly derived from it (industry, job title, company age, target customers), answer and set "derived":true. Otherwise set value to "[MISSING: ask user]" and "missing":true.',
    '3. For select/radio fields, copy ONE option verbatim from the provided options, or set missing:true.',
    '4. Never answer consent / terms / privacy / newsletter fields — set missing:true.',
    'Profile JSON:',
    JSON.stringify(profile || {}),
  ].join('\n');
}

function buildUser(scan) {
  const lines = scan.fields.map((f, i) => {
    const opts = f.options && f.options.length ? ` options=${JSON.stringify(f.options)}` : '';
    return `#${i} fid=${f.fid} label=${JSON.stringify(f.label)} kind=${f.kind}${opts} current=${JSON.stringify(f.value || '')}`;
  });
  return [
    `Page: ${scan.title} (${scan.url})`,
    'Fields:',
    ...lines,
    '',
    'Reply with ONLY this JSON: {"answers":[{"fid":"...","value":"...","missing":false}]} — value copied verbatim for selects; missing:true where a fact is unknown or the field is consent/terms.',
  ].join('\n');
}

function parseAnswers(raw) {
  if (!raw) return [];
  let t = String(raw).replace(/```json/gi, '```').replace(/```/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < 0) return [];
  try {
    const obj = JSON.parse(t.slice(a, b + 1));
    return Array.isArray(obj.answers) ? obj.answers : [];
  } catch { return []; }
}

// ---- Playwright fill ----

const CONSENT_RE = /terms|agree|consent|privacy|subscribe|newsletter/i;

/**
 * Attach Playwright to the user's live session and fill the form currently
 * open in it (optionally navigating to applyUrl first). Never submits.
 * @param {number} userId
 * @param {{applyUrl?:string, profile:Object}} opts
 * @returns {Promise<{filled:number, missing:Array, failed:number, url:string}>}
 */
async function fillCurrentPage(userId, opts) {
  const s = sessions.get(userId);
  if (!s) throw new Error('No live co-browse session — start one first');
  if (!kiro) throw new Error('Kiro answer engine unavailable');

  const { chromium } = require('playwright-core');
  const browser = await chromium.connectOverCDP(s.connectUrl);
  try {
    const context = browser.contexts()[0];
    const page = (context.pages() && context.pages()[0]) || (await context.newPage());
    if (opts.applyUrl) {
      await page.goto(opts.applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
    }

    // Scan visible fields, tagging each with a stable fid.
    const scan = await page.evaluate(() => {
      const out = [];
      let n = 0;
      const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
      const labelFor = (el) => {
        if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent.trim(); }
        const wrap = el.closest('label'); if (wrap) return wrap.textContent.trim();
        return (el.getAttribute('aria-label') || el.placeholder || el.name || '').trim();
      };
      for (const el of document.querySelectorAll('input, textarea, select')) {
        if (n >= 60) break;
        const type = (el.type || '').toLowerCase();
        if (['password', 'hidden', 'file', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) continue;
        if (el.disabled || el.readOnly || !vis(el)) continue;
        if (el.closest('form') && el.closest('form').querySelector('input[type="password"]')) continue;
        const fid = 'cb' + n;
        el.setAttribute('data-cb-fid', fid);
        const tag = el.tagName.toLowerCase();
        const kind = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea'
          : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'text';
        const field = { fid, label: labelFor(el).slice(0, 120), kind, value: el.value || '' };
        if (tag === 'select') field.options = Array.from(el.options).map((o) => o.textContent.trim()).filter(Boolean);
        out.push(field);
        n += 1;
      }
      return { url: location.href, title: document.title, fields: out };
    });

    if (!scan.fields.length) return { filled: 0, missing: [], failed: 0, url: scan.url };

    // Generate truthful answers via Kiro.
    const gen = await kiro.generateText({
      system: buildSystem(opts.profile),
      user: buildUser(scan),
      model: 'kiro/claude-haiku-4.5',
      apiKey: (process.env.KIRO_API_KEY || '').trim(),
    });
    const answers = parseAnswers(gen.text);

    let filled = 0;
    let failed = 0;
    const missing = [];
    for (const ans of answers) {
      if (!ans || !ans.fid) continue;
      const field = scan.fields.find((f) => f.fid === ans.fid);
      if (!field) continue;
      const val = ans.value == null ? '' : String(ans.value);
      if (ans.missing || val.includes('[MISSING')) {
        missing.push({ label: field.label, why: 'not in profile / consent' });
        continue;
      }
      if (CONSENT_RE.test(field.label)) { missing.push({ label: field.label, why: 'consent — left for you' }); continue; }
      const sel = `[data-cb-fid="${ans.fid}"]`;
      try {
        if (field.kind === 'select') {
          await page.selectOption(sel, { label: val }).catch(async () => {
            await page.selectOption(sel, val);
          });
        } else if (field.kind === 'checkbox' || field.kind === 'radio') {
          // Never auto-check consent; for others only if a clear yes.
          if (/^(true|yes|on|1)$/i.test(val)) await page.check(sel).catch(() => {});
        } else {
          await page.fill(sel, val);
        }
        filled += 1;
      } catch {
        failed += 1;
      }
    }
    return { filled, missing, failed, url: scan.url };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { configured, startSession, stopSession, fillCurrentPage };
