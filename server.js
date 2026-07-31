require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = require('./server/db.js');
const auth = require('./server/auth.js');

const app = express();
// Scalingo terminates TLS at its router; trust it so req.secure is correct
// and session cookies get the Secure flag in production.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENCODE_MODEL || 'deepseek-v4-flash-free';

const DATA_DIR = path.join(__dirname, 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const PROGRAMS_PATH = path.join(DATA_DIR, 'programs.json');

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(auth.attach);

// ---- Profile helpers ----

function defaultProfile() {
  return {
    basic: {
      startupName: '', website: '', email: '', description: '',
      country: '', foundedYear: '', phone: ''
    },
    extended: {
      stage: '', fundingRaised: '', teamSize: '', industry: '',
      linkedin: '', pitch: '', techStack: '', monthlyCloudSpend: '',
      incorporated: '', founderName: '', founderRole: ''
    }
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Read + parse a JSON file; return fallback on missing/unreadable/malformed.
function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function loadProfile() {
  const defaults = defaultProfile();
  const stored = readJsonSafe(PROFILE_PATH, null);
  if (!stored || typeof stored !== 'object') {
    return defaults;
  }
  // Merge stored over defaults, preserving the full schema shape.
  return {
    basic: Object.assign({}, defaults.basic, stored.basic || {}),
    extended: Object.assign({}, defaults.extended, stored.extended || {})
  };
}

function saveProfile(profile) {
  ensureDataDir();
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf8');
}

// Resolve a dotted path like "basic.startupName" against an object.
function resolvePath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return acc[key];
    return undefined;
  }, obj);
}

function isFilled(value) {
  return typeof value === 'string' ? value.trim() !== ''
    : value !== undefined && value !== null && value !== '';
}

// Lazily require the answer engine (Agent E). Returns null if unavailable.
function loadAnswerEngine() {
  try {
    return require('./server/answers.js');
  } catch (err) {
    return null;
  }
}

function getApiKey() {
  // Prefer Scalemax (OpenAI-compatible, browser-CORS-enabled) — it powers both
  // the server-side answer engine and the page-agent snippet. Fall back to an
  // Anthropic key if Scalemax isn't configured.
  const key = process.env.SCALEMAX_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  return key.trim() !== '' ? key.trim() : null;
}

// Merge an arbitrary stored object over the full default schema shape.
function normalizeProfile(stored) {
  const defaults = defaultProfile();
  const body = stored && typeof stored === 'object' ? stored : {};
  return {
    basic: Object.assign({}, defaults.basic, body.basic || {}),
    extended: Object.assign({}, defaults.extended, body.extended || {})
  };
}

// Profile for this request: the logged-in user's DB profile, or the legacy
// single-user file profile for anonymous requests (keeps local dashboard and
// the Chrome extension's unauthenticated sync working unchanged).
async function profileForRequest(req) {
  if (req.userId) {
    const stored = await db.getProfile(req.userId);
    return normalizeProfile(stored);
  }
  return loadProfile();
}

// ---- Auth routes ----

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

app.post('/api/register', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ ok: false, error: 'Username: 3-32 chars, letters/digits/._-' });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser(username, passwordHash);
    auth.setSessionCookie(req, res, auth.signSession(user.id));
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    if (err.message === 'USERNAME_TAKEN') {
      return res.status(409).json({ ok: false, error: 'Username already taken' });
    }
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const user = await db.getUserByUsername(username);
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }
    auth.setSessionCookie(req, res, auth.signSession(user.id));
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/filled', async (req, res) => {
  try {
    if (!req.userId) return res.json({ ok: true, filled: [] });
    res.json({ ok: true, filled: await db.getFilled(req.userId) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/filled', async (req, res) => {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'Log in to track filled applications' });
  try {
    const programId = String((req.body && req.body.programId) || '').trim();
    const filled = !(req.body && req.body.filled === false);
    if (!programId) return res.status(400).json({ ok: false, error: 'programId required' });
    await db.setFilled(req.userId, programId, filled);
    res.json({ ok: true, filled: await db.getFilled(req.userId) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    if (!req.userId) return res.json({ ok: true, user: null });
    const user = await db.getUserById(req.userId);
    if (!user) return res.json({ ok: true, user: null });
    const profile = normalizeProfile(await db.getProfile(req.userId));
    res.json({ ok: true, user, profile });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not load account' });
  }
});

// ---- Routes ----

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/profile', async (req, res) => {
  try {
    res.json(await profileForRequest(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profile', async (req, res) => {
  const merged = normalizeProfile(req.body);
  try {
    if (req.userId) {
      await db.saveProfile(req.userId, merged);
    } else {
      saveProfile(merged);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/programs', async (req, res) => {
  const programs = readJsonSafe(PROGRAMS_PATH, []);
  if (!Array.isArray(programs)) {
    return res.json([]);
  }
  let profile;
  try {
    profile = await profileForRequest(req);
  } catch (_e) {
    profile = defaultProfile();
  }
  const augmented = programs.map((program) => {
    const required = Array.isArray(program.requiredProfileFields)
      ? program.requiredProfileFields : [];
    const missingFields = required.filter(
      (field) => !isFilled(resolvePath(profile, field))
    );
    return Object.assign({}, program, {
      unlocked: missingFields.length === 0,
      missingFields
    });
  });
  res.json(augmented);
});

app.get('/api/settings', (req, res) => {
  res.json({ hasApiKey: getApiKey() !== null, model: MODEL });
});

function findProgram(programId) {
  const programs = readJsonSafe(PROGRAMS_PATH, []);
  if (!Array.isArray(programs)) return null;
  return programs.find((p) => p && p.id === programId) || null;
}

app.post('/api/generate-answers', async (req, res) => {
  const programId = req.body && req.body.programId;
  const program = findProgram(programId);
  if (!program) {
    return res.status(404).json({ error: 'program not found' });
  }

  const engine = loadAnswerEngine();
  if (!engine || typeof engine.generateAnswers !== 'function') {
    return res.status(503).json({ error: 'answer engine not ready' });
  }

  try {
    const profile = await profileForRequest(req);
    const result = await engine.generateAnswers(profile, program, getApiKey());
    res.json({ answers: result.answers, mode: result.mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fill-payload/:programId', async (req, res) => {
  // The snippet calls our /api/llm proxy (not Scalemax directly), so the payload
  // returns a PROXY TOKEN, never the real model key. Same production guard as
  // /api/agent-generate: when AGENT_TOKEN is set, require the matching header.
  const fillToken = process.env.AGENT_TOKEN && process.env.AGENT_TOKEN.trim();
  if (fillToken && req.get('x-agent-token') !== fillToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const program = findProgram(req.params.programId);
  if (!program) {
    return res.status(404).json({ error: 'program not found' });
  }

  const engine = loadAnswerEngine();
  if (!engine || typeof engine.generateAnswers !== 'function') {
    return res.status(503).json({ error: 'answer engine not ready' });
  }

  try {
    const profile = await profileForRequest(req);
    const apiKey = getApiKey();
    const result = await engine.generateAnswers(profile, program, apiKey);
    const answers = result.answers || [];
    // The snippet authenticates to our /api/llm proxy with this token (equals
    // AGENT_TOKEN in production, a harmless placeholder locally) — NOT the real
    // model key, which stays server-side in the proxy.
    const snippetKey = (process.env.AGENT_TOKEN && process.env.AGENT_TOKEN.trim()) || 'launchpad';

    const fieldLines = answers
      .map((a) => `${a.label}: ${a.value}`)
      .join('\n');

    const instruction =
      `You are filling out the "${program.name}" application form that is ` +
      `currently open on this page. Fill in each form field below using the ` +
      `matching value. Match by the field's visible label, placeholder, or ` +
      `nearby text.\n\n` +
      `${fieldLines}\n\n` +
      `Rules:\n` +
      `- Fill only the fields on the current page.\n` +
      `- If you cannot find a field for a value, skip it and move on.\n` +
      `- Do NOT click the final submit/apply button — leave the form for the ` +
      `user to review and submit themselves.`;

    res.json({ program, profile, answers, apiKey: snippetKey, instruction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- LaunchPad Agent (Chrome extension) install helper ----
// A web page cannot install an extension (Chrome removed inline installs),
// but this local server CAN launch Chrome. Two fixed, safe actions only:
//   mode "open" — open chrome://extensions so the user can Load unpacked
//   mode "load" — launch Chrome with --load-extension for an instant session try
const { spawn } = require('child_process');

const EXTENSION_DIR = path.join(__dirname, 'extension');

function findChrome() {
  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['LocalAppData'] || '', 'Google/Chrome/Application/chrome.exe')
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

app.post('/api/install-agent', (req, res) => {
  const mode = req.body && req.body.mode === 'load' ? 'load' : 'open';
  const chrome = findChrome();
  if (!chrome) {
    return res.status(404).json({
      ok: false,
      error: 'Chrome not found in the usual install locations',
      extensionPath: EXTENSION_DIR
    });
  }
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    return res.status(404).json({ ok: false, error: 'extension folder not found', extensionPath: EXTENSION_DIR });
  }

  const args = mode === 'load'
    ? [`--load-extension=${EXTENSION_DIR}`, 'http://localhost:3000']
    : ['chrome://extensions/'];

  try {
    const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ ok: true, mode, extensionPath: EXTENSION_DIR });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, extensionPath: EXTENSION_DIR });
  }
});

// ---- Kiro model proxy for the LaunchPad Agent extension ----
// Kiro (ksk_) keys only speak a native AWS protocol that a browser extension
// can't reach directly (CORS + event-stream framing). The extension posts
// {system, user, model} here; the key stays server-side in .env.
const kiro = (() => { try { return require('./server/kiro.js'); } catch { return null; } })();

app.post('/api/agent-generate', async (req, res) => {
  // Production guard: when AGENT_TOKEN is set, callers must present it.
  const agentToken = process.env.AGENT_TOKEN && process.env.AGENT_TOKEN.trim();
  if (agentToken && req.get('x-agent-token') !== agentToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const system = typeof body.system === 'string' ? body.system : '';
  const user = typeof body.user === 'string' ? body.user : '';
  const model = typeof body.model === 'string' ? body.model : 'kiro/claude-haiku-4.5';

  if (!kiro) return res.status(503).json({ ok: false, error: 'Kiro client not available' });
  const apiKey = process.env.KIRO_API_KEY && process.env.KIRO_API_KEY.trim();
  if (!apiKey) return res.status(401).json({ ok: false, error: 'KIRO_API_KEY not set in .env' });
  if (!user) return res.status(400).json({ ok: false, error: 'user prompt required' });

  try {
    const result = await kiro.generateText({ system, user, model, apiKey });
    res.json({ ok: true, data: { text: result.text, model: result.model } });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// OpenAI-compatible LLM proxy for the page-agent snippet (snippet-builder.js).
// The snippet runs INSIDE the application page (e.g. newrelic.com). Calling
// Scalemax directly from there depends on the browser resolving api.scalemax.pro
// (flaky home DNS -> ERR_NAME_NOT_RESOLVED) and would embed the key in that page.
// Instead the snippet calls THIS endpoint on the LaunchPad origin it was served
// from (already resolved), and we proxy to Scalemax with the key kept server-side.
// Open CORS so it works from any application page.
function setLlmCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Max-Age', '86400');
}
app.options('/api/llm/v1/chat/completions', (req, res) => {
  setLlmCors(res);
  res.status(204).end();
});
app.post('/api/llm/v1/chat/completions', async (req, res) => {
  setLlmCors(res);
  // Reuse AGENT_TOKEN as the shared secret when set: page-agent sends the snippet
  // key as `Authorization: Bearer <token>`. Locally (no AGENT_TOKEN) it's open.
  const agentToken = process.env.AGENT_TOKEN && process.env.AGENT_TOKEN.trim();
  if (agentToken) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer !== agentToken) return res.status(401).json({ error: { message: 'unauthorized' } });
  }
  const key = (process.env.SCALEMAX_API_KEY || '').trim();
  if (!key) return res.status(503).json({ error: { message: 'SCALEMAX_API_KEY not set' } });
  const base = (process.env.SCALEMAX_BASE_URL || 'https://api.scalemax.pro/token/v1').replace(/\/+$/, '');
  const model = (process.env.SCALEMAX_MODEL || 'deepseek-v4-flash').trim();
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  // Force our model + a generous max_tokens. DeepSeek V4 Flash is a reasoning
  // model: a small client max_tokens gets consumed by hidden reasoning and the
  // real answer is truncated (page-agent: "Response truncated: max tokens reached").
  const maxTokens = Math.max(Number(incoming.max_tokens) || 0, 16000);
  // Disable hidden reasoning unless the caller already asked for it — ~2.7x faster.
  const ctk = Object.assign({ enable_thinking: false }, incoming.chat_template_kwargs);
  const payload = Object.assign({}, incoming, { model, max_tokens: maxTokens, chat_template_kwargs: ctk });
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (err) {
    res.status(502).json({ error: { message: 'LLM proxy failed: ' + err.message } });
  }
});

// ---- Live co-browse (Steel.dev) ----
// The logged-in user starts a live cloud-browser session, logs into their own
// account by hand in the embedded view, then the server fills the form in the
// same browser (never submits). Requires login + STEEL_API_KEY.
const cobrowse = (() => { try { return require('./server/cobrowse.js'); } catch { return null; } })();

function requireLogin(req, res) {
  if (!req.userId) { res.status(401).json({ ok: false, error: 'Log in to use co-browse' }); return false; }
  if (!cobrowse || !cobrowse.configured()) {
    res.status(503).json({ ok: false, error: 'Co-browse not configured — set STEEL_API_KEY' });
    return false;
  }
  return true;
}

app.get('/api/cobrowse/status', (req, res) => {
  res.json({ ok: true, configured: !!(cobrowse && cobrowse.configured()), loggedIn: !!req.userId });
});

app.post('/api/cobrowse/start', async (req, res) => {
  if (!requireLogin(req, res)) return;
  try {
    const data = await cobrowse.startSession(req.userId);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/cobrowse/open', async (req, res) => {
  if (!requireLogin(req, res)) return;
  try {
    const url = req.body && typeof req.body.url === 'string' ? req.body.url : '';
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'valid url required' });
    const data = await cobrowse.openUrl(req.userId, url);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Fill runs in the BACKGROUND and the client polls /fill-result — otherwise a
// slow fill (proxy latency + heavy page) exceeds Scalingo's ~30s request
// timeout and the browser reports "server not reachable".
const cobrowseFills = new Map(); // userId -> {status, result, error, ts}

app.post('/api/cobrowse/fill', async (req, res) => {
  if (!requireLogin(req, res)) return;
  const userId = req.userId;
  const applyUrl = req.body && typeof req.body.applyUrl === 'string' ? req.body.applyUrl : '';
  const programId = req.body && typeof req.body.programId === 'string' ? req.body.programId : '';
  let profile;
  try { profile = await profileForRequest(req); } catch { profile = defaultProfile(); }

  cobrowseFills.set(userId, { status: 'running', ts: Date.now() });
  res.json({ ok: true, data: { started: true } }); // respond immediately

  cobrowse.fillCurrentPage(userId, { applyUrl, profile })
    .then(async (result) => {
      if (programId && result && result.filled > 0) {
        try { await db.setFilled(userId, programId, true); } catch { /* non-fatal */ }
      }
      cobrowseFills.set(userId, { status: 'done', result, ts: Date.now() });
    })
    .catch((err) => {
      cobrowseFills.set(userId, { status: 'error', error: err.message, ts: Date.now() });
    });
});

app.get('/api/cobrowse/fill-result', (req, res) => {
  if (!req.userId) return res.status(401).json({ ok: false, error: 'Log in' });
  const j = cobrowseFills.get(req.userId);
  if (!j) return res.json({ ok: true, status: 'idle' });
  res.json({ ok: true, status: j.status, result: j.result || null, error: j.error || null });
});

app.post('/api/cobrowse/stop', async (req, res) => {
  if (!req.userId) return res.json({ ok: true });
  try { await cobrowse.stopSession(req.userId); } catch { /* ignore */ }
  res.json({ ok: true });
});

db.init()
  .then(() => {
    console.log(`[db] storage driver: ${db.mode}`);
    app.listen(PORT, () => {
      console.log(`LaunchPad running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[db] init failed:', err.message);
    process.exit(1);
  });
