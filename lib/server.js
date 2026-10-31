import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
export const SESSION_COOKIE = '__Host-arixdoc_session';
export const FREE_PLAN = Object.freeze({
  name: 'Free', monthlyAuthorizations: 10000, requestsPerMinutePerKey: 60,
  requestsPerMinutePerAccount: 120, maxKeys: 3
});

export function assertRedisConfigured() {
  if (!UPSTASH_URL || !TOKEN) throw new Error('Upstash Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.');
}

export async function redis(...command) {
  assertRedisConfigured();
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(6500)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Upstash Redis error: ${data.error || response.statusText}`);
  return data.result;
}

export async function evalLua(script, keys = [], args = []) {
  return redis('EVAL', script, String(keys.length), ...keys, ...args.map(String));
}

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
export const emailDigest = (email) => createHmac('sha256', TOKEN).update(`email:${email}`).digest('hex');
export const randomId = (bytes = 18) => randomBytes(bytes).toString('base64url');
export const nowMonth = () => new Date().toISOString().slice(0, 7).replace('-', '');

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('Enter a valid email address.');
  return email;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return { salt: salt.toString('base64url'), hash: Buffer.from(derived).toString('base64url') };
}

export async function verifyPassword(password, salt, expected) {
  const derived = await scrypt(String(password), Buffer.from(salt, 'base64url'), 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const actual = Buffer.from(derived);
  const wanted = Buffer.from(expected, 'base64url');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function json(res, status, body, headers = {}) {
  res.statusCode = status;
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
  for (const [name, value] of Object.entries({ ...base, ...headers })) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

export function parseBody(req) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > 16384) throw new Error('Request body exceeds 16 KB.');
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

export function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === String(host).toLowerCase(); } catch { return false; }
}

export function getCookie(req, name) {
  const cookie = String(req.headers.cookie || '');
  for (const segment of cookie.split(';')) {
    const [key, ...rest] = segment.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export async function sessionUser(req) {
  const sid = getCookie(req, SESSION_COOKIE);
  if (!sid || sid.length > 128) return null;
  const raw = await redis('GET', `arixdoc:session:${sha256(sid)}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  const userRaw = await redis('GET', `arixdoc:user:${session.userId}`);
  if (!userRaw) return null;
  return { sid, session, user: JSON.parse(userRaw) };
}

export async function createSession(userId) {
  const sid = randomId(32);
  await redis('SET', `arixdoc:session:${sha256(sid)}`, JSON.stringify({ userId, createdAt: Date.now() }), 'EX', 604800);
  return sid;
}

export function sessionCookie(sid) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function fixedWindowLimit(key, max, windowSeconds) {
  const script = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; local t = redis.call('TTL', KEYS[1]); return {n, t}`;
  const [count, ttl] = await evalLua(script, [key], [windowSeconds]);
  return { allowed: Number(count) <= max, count: Number(count), retryAfter: Math.max(1, Number(ttl) || windowSeconds) };
}

export function validateOrigins(input, fallbackOrigin) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/).filter(Boolean);
  const origins = [...new Set(values.map((value) => {
    const url = new URL(String(value).trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid origin: ${value}`);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('HTTP origins are only allowed for localhost development.');
    return url.origin;
  }))];
  if (!origins.length && fallbackOrigin) origins.push(fallbackOrigin);
  if (origins.length > 10) throw new Error('A key can have at most 10 allowed origins.');
  if (!origins.length) throw new Error('Add at least one allowed website origin.');
  return origins;
}

export function allowedOriginHeader(origin, permitted) {
  return origin && permitted ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
}

export async function consumeAuthorization({ keyId, ownerId }) {
  const month = nowMonth();
  const minute = Math.floor(Date.now() / 60000);
  const keys = [
    `arixdoc:meter:key-minute:${keyId}:${minute}`,
    `arixdoc:meter:account-minute:${ownerId}:${minute}`,
    `arixdoc:meter:key-month:${keyId}:${month}`,
    `arixdoc:meter:account-month:${ownerId}:${month}`
  ];
  const script = `
local km = tonumber(redis.call('INCR', KEYS[1])); if km == 1 then redis.call('EXPIRE', KEYS[1], 120); end
if km > tonumber(ARGV[1]) then return {0, 'key_rate', km, 0}; end
local am = tonumber(redis.call('INCR', KEYS[2])); if am == 1 then redis.call('EXPIRE', KEYS[2], 120); end
if am > tonumber(ARGV[2]) then return {0, 'account_rate', km, am}; end
local kmonth = tonumber(redis.call('INCR', KEYS[3])); if kmonth == 1 then redis.call('EXPIRE', KEYS[3], 3456000); end
if kmonth > tonumber(ARGV[3]) then redis.call('DECR', KEYS[3]); return {0, 'key_quota', kmonth - 1, am}; end
local amonth = tonumber(redis.call('INCR', KEYS[4])); if amonth == 1 then redis.call('EXPIRE', KEYS[4], 3456000); end
if amonth > tonumber(ARGV[3]) then redis.call('DECR', KEYS[3]); redis.call('DECR', KEYS[4]); return {0, 'account_quota', kmonth - 1, am}; end
return {1, 'ok', kmonth, amonth};`;
  const result = await evalLua(script, keys, [FREE_PLAN.requestsPerMinutePerKey, FREE_PLAN.requestsPerMinutePerAccount, FREE_PLAN.monthlyAuthorizations]);
  return { allowed: Number(result[0]) === 1, reason: String(result[1]), keyMonth: Number(result[2] || 0), accountMonth: Number(result[3] || 0), month };
}
