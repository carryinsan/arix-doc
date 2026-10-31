import {
  FREE_PLAN, SESSION_COOKIE, assertRedisConfigured, clearSessionCookie, consumeAuthorization,
  createSession, emailDigest, evalLua, fixedWindowLimit, hashPassword, isSameOrigin,
  json, normalizeEmail, parseBody, randomId, redis, sessionCookie, sessionUser,
  sha256, validateOrigins, verifyPassword, allowedOriginHeader
} from '../lib/server.js';

const emailIndexKey = (email) => `arixdoc:email:${emailDigest(email)}`;
const accountKeysKey = (userId) => `arixdoc:user-keys:${userId}`;
const monthKey = () => new Date().toISOString().slice(0, 7).replace('-', '');

async function listKeys(userId) {
  const ids = await redis('SMEMBERS', accountKeysKey(userId)) || [];
  if (!ids.length) return [];
  const values = await redis('MGET', ...ids.map((id) => `arixdoc:key:${id}`));
  return (values || []).filter(Boolean).map((value) => JSON.parse(value));
}

async function requireDashboardSession(req, res) {
  if (!isSameOrigin(req)) {
    json(res, 403, { error: 'Cross-origin dashboard request rejected.' });
    return null;
  }
  try {
    const auth = await sessionUser(req);
    if (!auth) {
      json(res, 401, { error: 'Please sign in again.' });
      return null;
    }
    return auth;
  } catch {
    json(res, 503, { error: 'Session storage is temporarily unavailable.' });
    return null;
  }
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

async function signup(email, password, req, res) {
  if (!validPassword(password)) return json(res, 400, { error: 'Use a password between 12 and 128 characters.' });
  const limit = await fixedWindowLimit(`arixdoc:limit:signup:${emailDigest(email)}`, 5, 3600);
  if (!limit.allowed) return json(res, 429, { error: 'Too many signup attempts. Try again later.', retryAfter: limit.retryAfter }, { 'Retry-After': String(limit.retryAfter) });
  const credential = await hashPassword(password);
  const userId = randomId(18);
  const user = { id: userId, email, passwordSalt: credential.salt, passwordHash: credential.hash, createdAt: new Date().toISOString(), plan: 'free' };
  const script = `if redis.call('SET', KEYS[1], ARGV[1], 'NX') then redis.call('SET', KEYS[2], ARGV[2]); return 1 else return 0 end`;
  const created = await evalLua(script, [emailIndexKey(email), `arixdoc:user:${userId}`], [userId, JSON.stringify(user)]);
  if (Number(created) !== 1) return json(res, 409, { error: 'An account with this email already exists.' });
  const sid = await createSession(userId);
  res.setHeader('Set-Cookie', sessionCookie(sid));
  return json(res, 201, { ok: true, user: { email, plan: 'Free' }, plan: FREE_PLAN });
}

async function login(email, password, res) {
  const limit = await fixedWindowLimit(`arixdoc:limit:login:${emailDigest(email)}`, 12, 900);
  if (!limit.allowed) return json(res, 429, { error: 'Too many sign-in attempts. Try again later.', retryAfter: limit.retryAfter }, { 'Retry-After': String(limit.retryAfter) });
  const id = await redis('GET', emailIndexKey(email));
  const raw = id ? await redis('GET', `arixdoc:user:${id}`) : null;
  if (!raw) return json(res, 401, { error: 'Email or password is incorrect.' });
  const user = JSON.parse(raw);
  if (!(await verifyPassword(password, user.passwordSalt, user.passwordHash))) return json(res, 401, { error: 'Email or password is incorrect.' });
  const sid = await createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(sid));
  return json(res, 200, { ok: true, user: { email: user.email, plan: 'Free' }, plan: FREE_PLAN });
}

async function createApiKey(user, body, req, res) {
  const existing = await listKeys(user.id);
  if (existing.length >= FREE_PLAN.maxKeys) return json(res, 403, { error: `Free accounts can have up to ${FREE_PLAN.maxKeys} active keys. Revoke one to create another.` });
  const name = String(body.name || 'My application').trim().slice(0, 60) || 'My application';
  const fallback = req.headers.origin ? new URL(req.headers.origin).origin : '';
  const origins = validateOrigins(body.allowedOrigins, fallback);
  const id = randomId(12);
  const secret = `arx_live_${randomId(32)}`;
  const digest = sha256(secret);
  const metadata = { id, name, ownerId: user.id, createdAt: new Date().toISOString(), allowedOrigins: origins, active: true, digest, lastUsedAt: null };
  const script = `if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end; redis.call('SADD', KEYS[1], ARGV[1]); redis.call('SET', KEYS[2], ARGV[2]); redis.call('SET', KEYS[3], ARGV[3]); return 1`;
  const saved = await evalLua(script,
    [accountKeysKey(user.id), `arixdoc:key:${id}`, `arixdoc:key-hash:${digest}`],
    [id, JSON.stringify(metadata), id, FREE_PLAN.maxKeys]);
  if (Number(saved) !== 1) return json(res, 403, { error: 'Key limit reached. Revoke an existing key first.' });
  return json(res, 201, { ok: true, key: secret, metadata: { ...metadata, digest: undefined } });
}

async function updateKey(user, body, res) {
  const id = String(body.keyId || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json(res, 400, { error: 'Invalid key ID.' });
  const raw = await redis('GET', `arixdoc:key:${id}`);
  if (!raw) return json(res, 404, { error: 'Key not found.' });
  const metadata = JSON.parse(raw);
  if (metadata.ownerId !== user.id || !metadata.active) return json(res, 404, { error: 'Key not found.' });
  metadata.allowedOrigins = validateOrigins(body.allowedOrigins, '');
  await redis('SET', `arixdoc:key:${id}`, JSON.stringify(metadata));
  return json(res, 200, { ok: true });
}

async function revokeKey(user, body, res) {
  const id = String(body.keyId || '');
  const raw = await redis('GET', `arixdoc:key:${id}`);
  if (!raw) return json(res, 404, { error: 'Key not found.' });
  const metadata = JSON.parse(raw);
  if (metadata.ownerId !== user.id || !metadata.active) return json(res, 404, { error: 'Key not found.' });
  metadata.active = false;
  metadata.revokedAt = new Date().toISOString();
  await redis('SET', `arixdoc:key:${id}`, JSON.stringify(metadata));
  await redis('DEL', `arixdoc:key-hash:${metadata.digest}`);
  await redis('SREM', accountKeysKey(user.id), id);
  return json(res, 200, { ok: true });
}

async function dashboardData(user, res) {
  const month = monthKey();
  const accountUsage = Number(await redis('GET', `arixdoc:meter:account-month:${user.id}:${month}`) || 0);
  const keys = await listKeys(user.id);
  const hydrated = await Promise.all(keys.map(async (key) => {
    const usage = Number(await redis('GET', `arixdoc:meter:key-month:${key.id}:${month}`) || 0);
    return { id: key.id, name: key.name, active: key.active, createdAt: key.createdAt, allowedOrigins: key.allowedOrigins, lastUsedAt: key.lastUsedAt, usage };
  }));
  return json(res, 200, { ok: true, user: { email: user.email, plan: 'Free' }, plan: FREE_PLAN, usage: { month, authorizations: accountUsage, limit: FREE_PLAN.monthlyAuthorizations }, keys: hydrated });
}

async function authorizeApiKey(req, body, res) {
  const origin = String(req.headers.origin || '');
  if (!origin) return json(res, 403, { allowed: false, error: 'Browser Origin header is required for publishable API keys.' });
  let normalizedOrigin;
  try { normalizedOrigin = new URL(origin).origin; } catch { return json(res, 403, { allowed: false, error: 'Invalid Origin header.' }); }
  const key = String(req.headers['x-arix-key'] || req.headers.authorization?.replace(/^Bearer\s+/i, '') || body.key || '');
  if (!/^arx_live_[A-Za-z0-9_-]{32,100}$/.test(key)) return json(res, 401, { allowed: false, error: 'Invalid API key.' });
  const digest = sha256(key);
  const keyId = await redis('GET', `arixdoc:key-hash:${digest}`);
  if (!keyId) return json(res, 401, { allowed: false, error: 'API key is invalid or revoked.' });
  const raw = await redis('GET', `arixdoc:key:${keyId}`);
  if (!raw) return json(res, 401, { allowed: false, error: 'API key is invalid or revoked.' });
  const metadata = JSON.parse(raw);
  if (!metadata.active || metadata.digest !== digest) return json(res, 401, { allowed: false, error: 'API key is inactive.' });
  if (!Array.isArray(metadata.allowedOrigins) || !metadata.allowedOrigins.includes(normalizedOrigin)) {
    return json(res, 403, { allowed: false, error: 'This website origin is not authorized for the API key.' });
  }
  const usage = await consumeAuthorization({ keyId, ownerId: metadata.ownerId });
  if (!usage.allowed) {
    const reason = usage.reason.includes('rate') ? 'Rate limit exceeded.' : 'Monthly free-tier quota reached.';
    return json(res, 429, { allowed: false, error: reason, reason: usage.reason, plan: FREE_PLAN, usage: { month: usage.month, authorizations: usage.accountMonth } }, { 'Retry-After': usage.reason.includes('rate') ? '60' : '3600', ...allowedOriginHeader(normalizedOrigin, true) });
  }
  // Metering is performed in one atomic Redis script; document processing remains local.
  return json(res, 200, { allowed: true, plan: FREE_PLAN, usage: { month: usage.month, authorizations: usage.accountMonth, limit: FREE_PLAN.monthlyAuthorizations } }, { ...allowedOriginHeader(normalizedOrigin, true) });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      return json(res, 204, {}, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Arix-Key',
        'Access-Control-Max-Age': '600'
      });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST, OPTIONS' });
    assertRedisConfigured();
    const body = parseBody(req);
    const action = String(body.action || '');

    if (action === 'authorize') {
      return await authorizeApiKey(req, body, res);
    }

    if (!isSameOrigin(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });

    if (action === 'signup' || action === 'login') {
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (password.length > 128) return json(res, 400, { error: 'Password must be 128 characters or fewer.' });
      if (action === 'signup') return await signup(email, password, req, res);
      return await login(email, password, res);
    }

    if (action === 'logout') {
      const sid = req.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
      if (sid) await redis('DEL', `arixdoc:session:${sha256(decodeURIComponent(sid))}`);
      res.setHeader('Set-Cookie', clearSessionCookie());
      return json(res, 200, { ok: true });
    }

    const auth = await requireDashboardSession(req, res);
    if (!auth) return;
    if (action === 'me') return await dashboardData(auth.user, res);
    if (action === 'create_key') return await createApiKey(auth.user, body, req, res);
    if (action === 'update_key') return await updateKey(auth.user, body, res);
    if (action === 'revoke_key') return await revokeKey(auth.user, body, res);
    return json(res, 400, { error: 'Unknown action.' });
  } catch (error) {
    const message = String(error?.message || 'Unexpected server error.');
    if (message.includes('Upstash Redis is not configured')) return json(res, 503, { error: message });
    if (message === 'Enter a valid email address.' || message.includes('Invalid URL') || message.startsWith('Invalid origin:') || message.includes('HTTP origins') || message.includes('at most 10 allowed origins') || message.includes('Add at least one allowed website origin')) return json(res, 400, { error: message });
    // Avoid returning Redis command text, credentials, stack traces or internal details.
    return json(res, 500, { error: 'ArixDoc service error. Check the Vercel function logs for the request ID.' });
  }
}
