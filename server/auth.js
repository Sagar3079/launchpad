/**
 * Stateless session auth: HMAC-signed cookie tokens, no session store.
 * Token = "<userId>.<expiresEpochSeconds>.<hmacSha256Hex>", signed with
 * SESSION_SECRET. Survives server restarts as long as the secret is stable —
 * set SESSION_SECRET in production (a random per-boot secret is used
 * otherwise, which logs everyone out on each restart).
 */

'use strict';

const crypto = require('crypto');

const SECRET =
  (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');

if (!(process.env.SESSION_SECRET || '').trim()) {
  console.warn('[auth] SESSION_SECRET not set — sessions will reset on restart');
}

const COOKIE_NAME = 'lp_session';
const SESSION_DAYS = 30;

function hmac(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

/**
 * @param {number} userId
 * @returns {string} signed token
 */
function signSession(userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${userId}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

/**
 * @param {string} token
 * @returns {number|null} userId when valid and unexpired
 */
function verifySession(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [idStr, expStr, sig] = parts;
  const payload = `${idStr}.${expStr}`;
  const expected = hmac(payload);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
      return null;
    }
  } catch (_e) {
    return null;
  }
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const id = parseInt(idStr, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Minimal cookie-header parser (we only need our own cookie). */
function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/** Express middleware: sets req.userId (number) or null from the cookie. */
function attach(req, _res, next) {
  const cookies = parseCookies(req);
  req.userId = cookies[COOKIE_NAME] ? verifySession(cookies[COOKIE_NAME]) : null;
  next();
}

module.exports = { signSession, verifySession, setSessionCookie, clearSessionCookie, attach, COOKIE_NAME };
