/**
 * User + profile storage with two drivers:
 *  - PostgreSQL when SCALINGO_POSTGRESQL_URL / DATABASE_URL is set
 *    (Scalingo's PostgreSQL addon injects SCALINGO_POSTGRESQL_URL)
 *  - JSON file (data/users.json) otherwise — zero-setup local dev.
 *
 * All functions are async and driver-agnostic to the caller.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATABASE_URL =
  (process.env.SCALINGO_POSTGRESQL_URL || process.env.DATABASE_URL || '').trim();

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

/** @type {'postgres'|'file'} */
const mode = DATABASE_URL ? 'postgres' : 'file';

let pool = null;

// ---------------------------------------------------------------------------
// Postgres driver
// ---------------------------------------------------------------------------

function getPool() {
  if (pool) return pool;
  // Lazy-require so local file-mode never needs the pg package loaded.
  const { Pool } = require('pg');
  const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocalDb ? false : { rejectUnauthorized: false },
    max: 5,
  });
  return pool;
}

async function initPg() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS filled_programs (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      program_id TEXT NOT NULL,
      filled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, program_id)
    );
  `);
}

// ---------------------------------------------------------------------------
// File driver
// ---------------------------------------------------------------------------

function readStore() {
  try {
    const raw = fs.readFileSync(USERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.users)) return parsed;
  } catch (_e) {
    /* fresh store */
  }
  return { seq: 0, users: [] };
}

function writeStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function init() {
  if (mode === 'postgres') await initPg();
}

/**
 * @returns {Promise<{id:number, username:string}>}
 * @throws {Error} with message 'USERNAME_TAKEN'
 */
async function createUser(username, passwordHash) {
  if (mode === 'postgres') {
    try {
      const r = await getPool().query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [username, passwordHash],
      );
      return r.rows[0];
    } catch (err) {
      if (err && err.code === '23505') throw new Error('USERNAME_TAKEN');
      throw err;
    }
  }
  const store = readStore();
  if (store.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('USERNAME_TAKEN');
  }
  store.seq += 1;
  const user = {
    id: store.seq,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    profile: null,
  };
  store.users.push(user);
  writeStore(store);
  return { id: user.id, username: user.username };
}

/** @returns {Promise<{id:number, username:string, passwordHash:string}|null>} */
async function getUserByUsername(username) {
  if (mode === 'postgres') {
    const r = await getPool().query(
      'SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)',
      [username],
    );
    if (!r.rows[0]) return null;
    return { id: r.rows[0].id, username: r.rows[0].username, passwordHash: r.rows[0].password_hash };
  }
  const u = readStore().users.find(
    (x) => x.username.toLowerCase() === String(username).toLowerCase(),
  );
  return u ? { id: u.id, username: u.username, passwordHash: u.passwordHash } : null;
}

/** @returns {Promise<{id:number, username:string}|null>} */
async function getUserById(id) {
  if (mode === 'postgres') {
    const r = await getPool().query('SELECT id, username FROM users WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  const u = readStore().users.find((x) => x.id === id);
  return u ? { id: u.id, username: u.username } : null;
}

/** @returns {Promise<Object|null>} stored profile object or null */
async function getProfile(userId) {
  if (mode === 'postgres') {
    const r = await getPool().query('SELECT data FROM profiles WHERE user_id = $1', [userId]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const u = readStore().users.find((x) => x.id === userId);
  return u && u.profile ? u.profile : null;
}

async function saveProfile(userId, profile) {
  if (mode === 'postgres') {
    await getPool().query(
      `INSERT INTO profiles (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = now()`,
      [userId, profile],
    );
    return;
  }
  const store = readStore();
  const u = store.users.find((x) => x.id === userId);
  if (!u) throw new Error('user not found');
  u.profile = profile;
  writeStore(store);
}

/** @returns {Promise<string[]>} program ids the user has marked/auto-marked filled */
async function getFilled(userId) {
  if (mode === 'postgres') {
    const r = await getPool().query('SELECT program_id FROM filled_programs WHERE user_id = $1', [userId]);
    return r.rows.map((x) => x.program_id);
  }
  const u = readStore().users.find((x) => x.id === userId);
  return u && Array.isArray(u.filled) ? u.filled : [];
}

/** Add or remove a program from the user's filled set. */
async function setFilled(userId, programId, filled) {
  if (mode === 'postgres') {
    if (filled) {
      await getPool().query(
        `INSERT INTO filled_programs (user_id, program_id) VALUES ($1, $2)
         ON CONFLICT (user_id, program_id) DO NOTHING`,
        [userId, programId],
      );
    } else {
      await getPool().query('DELETE FROM filled_programs WHERE user_id = $1 AND program_id = $2', [userId, programId]);
    }
    return;
  }
  const store = readStore();
  const u = store.users.find((x) => x.id === userId);
  if (!u) throw new Error('user not found');
  const set = new Set(Array.isArray(u.filled) ? u.filled : []);
  if (filled) set.add(programId); else set.delete(programId);
  u.filled = Array.from(set);
  writeStore(store);
}

module.exports = { init, createUser, getUserByUsername, getUserById, getProfile, saveProfile, getFilled, setFilled, mode };
