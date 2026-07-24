require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENCODE_MODEL || 'deepseek-v4-flash-free';

const DATA_DIR = path.join(__dirname, 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const PROGRAMS_PATH = path.join(DATA_DIR, 'programs.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Profile helpers ----

function defaultProfile() {
  return {
    basic: {
      startupName: '', website: '', email: '', description: '',
      country: '', foundedYear: ''
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
  const key = process.env.ANTHROPIC_API_KEY;
  return key && key.trim() !== '' ? key.trim() : null;
}

// ---- Routes ----

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/profile', (req, res) => {
  res.json(loadProfile());
});

app.post('/api/profile', (req, res) => {
  const defaults = defaultProfile();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const merged = {
    basic: Object.assign({}, defaults.basic, body.basic || {}),
    extended: Object.assign({}, defaults.extended, body.extended || {})
  };
  try {
    saveProfile(merged);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/programs', (req, res) => {
  const programs = readJsonSafe(PROGRAMS_PATH, []);
  if (!Array.isArray(programs)) {
    return res.json([]);
  }
  const profile = loadProfile();
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
    const profile = loadProfile();
    const result = await engine.generateAnswers(profile, program, getApiKey());
    res.json({ answers: result.answers, mode: result.mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fill-payload/:programId', async (req, res) => {
  // This payload includes the Anthropic API key (consumed by the local
  // injection snippet). Same production guard as /api/agent-generate:
  // when AGENT_TOKEN is set, require the matching header.
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
    const profile = loadProfile();
    const apiKey = getApiKey();
    const result = await engine.generateAnswers(profile, program, apiKey);
    const answers = result.answers || [];

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

    res.json({ program, profile, answers, apiKey, instruction });
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

app.listen(PORT, () => {
  console.log(`LaunchPad running at http://localhost:${PORT}`);
});
