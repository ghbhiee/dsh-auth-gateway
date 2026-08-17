'use strict';
/*
 * DeepSeek Harness (dsh) auth gateway
 * Flow: passkey (WebAuthn) login -> pending -> terminal approval -> session cookie -> proxy to dsh
 *
 * A reverse proxy that sits in FRONT of `dsh web` and only lets an
 * authenticated browser through. It is not a dsh plugin: dsh's webserver has no
 * middleware/gate hook a plugin could use to guard the core UI, RPC, and event
 * websockets — the one fallback route is the app's own — so auth has to front
 * the process. nginx terminates TLS for the public host and proxies here,
 * forwarding Host/Origin/X-Forwarded-For.
 *
 * Everything deployment-specific is an env var (see README); the defaults keep
 * the original single-host behaviour.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const httpProxy = require('http-proxy');
const {

  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const HOST = process.env.DSH_GW_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_GW_PORT || 3090);
const DSH_TARGET = process.env.DSH_GW_TARGET || 'http://127.0.0.1:3080';
// The WebAuthn Relying Party ID: the exact public host the browser connects to.
// Passkeys are scoped to it, so it must match the domain in the address bar.
const RP_ID = process.env.DSH_GW_RP_ID || 'ds.tokencv.com';
const ORIGIN = process.env.DSH_GW_ORIGIN || `https://${RP_ID}`;
const RP_NAME = process.env.DSH_GW_RP_NAME || 'DeepSeek Harness';
const USER_NAME = process.env.DSH_GW_USER_NAME || 'herb';
const USER_DISPLAY = process.env.DSH_GW_USER_DISPLAY || 'Herb';
const COOKIE_NAME = process.env.DSH_GW_COOKIE_NAME || 'dsh_auth';
// How long a signed-in browser stays signed in before it must re-prove the
// passkey. Re-proving does NOT need terminal approval — the passkey is already
// trusted; this is just a freshness limit on the cookie.
const SESSION_TTL_MS = Number(process.env.DSH_SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;    // 5min
// A pending record now means "a login that is waiting for its passkey to be
// approved" — it only ever exists for a not-yet-trusted passkey, so it can
// afford a longer window than a per-login approval could.
const PENDING_TTL_MS = 30 * 60 * 1000;     // 30min
// Sweep decided/expired state off disk periodically (dsh-approve cleanup does
// the same on demand; this makes it happen without anyone remembering to run it).
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;  // 10min
// Opt-in: refuse a session cookie replayed from a different IP. Off by default
// because roaming between wifi/cellular legitimately changes the address.
const BIND_SESSION_IP = process.env.DSH_BIND_SESSION_IP === '1';

// ---- passkey trust state ----
// The unit of human approval is the passkey, not the login. A freshly
// registered credential sits at 'pending' until someone with terminal access
// vouches for it; after that it signs in on its own until revoked.
const CRED_PENDING = 'pending';
const CRED_APPROVED = 'approved';
const CRED_REVOKED = 'revoked';

// Credentials written before this model existed have no status field. Treat
// them as approved: they were already being used to sign in, and flipping them
// to pending would lock the only admin out of their own gateway.
function credStatus(c) {
  return c.status || CRED_APPROVED;
}

// State (credentials, sessions, signing secret) lives here. The dsh-approve CLI
// must read the SAME directory, so both default to it and both honour the env.
const STATE_DIR = process.env.DSH_GW_STATE_DIR || path.join(os.homedir(), '.dsh-gateway', 'state');
const PUBLIC_DIR = process.env.DSH_GW_PUBLIC_DIR || path.join(__dirname, 'public');
const CREDENTIALS_FILE = path.join(STATE_DIR, 'credentials.json');
const PENDING_DIR = path.join(STATE_DIR, 'pending');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const SECRET_FILE = path.join(STATE_DIR, 'secret');

for (const d of [PENDING_DIR, SESSIONS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---- base64url helpers (Node Buffer supports 'base64url') ----
const b64u = {
  encode: (buf) => Buffer.from(buf).toString('base64url'),
  decode: (s) => new Uint8Array(Buffer.from(s, 'base64url')),
};

// ---- minimal cookie helpers (no external dep) ----
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
function serializeCookie(name, value, opts = {}) {
  let s = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  if (opts.path) s += `; Path=${opts.path}`;
  if (opts.httpOnly) s += '; HttpOnly';
  if (opts.secure) s += '; Secure';
  if (opts.sameSite) s += `; SameSite=${opts.sameSite}`;
  return s;
}

// ---- secret (persistent signing key) ----
function getSecret() {
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(SECRET_FILE, 'utf8').trim();
}
const SECRET = getSecret();

// ---- JSON store helpers ----
function loadCredentials() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')); }
  catch { return []; }
}
function saveCredentials(list) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

// ---- in-memory challenge map ----
const challenges = new Map(); // key -> { challenge, meta, expires }

function storeChallenge(challengeValue, meta = {}) {
  const key = crypto.randomUUID();
  challenges.set(key, { challenge: challengeValue, meta, expires: Date.now() + CHALLENGE_TTL_MS });
  return key;
}
// Returns the whole record (challenge + meta), not just the challenge string:
// registration needs the label the user typed back when options were issued.
function takeChallenge(key) {
  const c = challenges.get(key);
  if (!c) return null;
  challenges.delete(key);
  if (c.expires < Date.now()) return null;
  return c;
}
// periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
}, 60 * 1000).unref();

// ---- pending terminal-approval records ----
function createPending(info) {
  const token = crypto.randomUUID();
  const rec = {
    token,
    // Which passkey this login is waiting on. Approval is granted to the
    // credential, so the poll just re-reads that credential's status.
    credentialId: info.credentialId,
    email: info.email || '',
    label: info.label || '',
    userName: info.userName,
    ip: info.ip,
    ua: info.ua,
    createdAt: Date.now(),
    status: 'pending',
  };
  fs.writeFileSync(path.join(PENDING_DIR, token + '.json'), JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}
function getPending(token) {
  if (!token || !/^[0-9a-f-]{36}$/.test(token)) return null;
  const f = path.join(PENDING_DIR, token + '.json');
  if (!fs.existsSync(f)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    // Too old to act on — drop it rather than let it be approved later.
    if (Date.now() - rec.createdAt > PENDING_TTL_MS) { deletePending(token); return null; }
    return rec;
  } catch { return null; }
}
function deletePending(token) {
  try { fs.unlinkSync(path.join(PENDING_DIR, token + '.json')); } catch {}
}

// ---- sessions ----
function sign(sid) {
  return crypto.createHmac('sha256', SECRET).update(sid).digest('base64url');
}
// Constant-time compare so signature verification can't be probed byte by byte.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function createSession(userName, ip, credentialId) {
  const sid = crypto.randomUUID();
  // credentialId is recorded so revoking a passkey can also cut the sessions
  // it produced — otherwise a revoked device keeps its cookie until expiry.
  const rec = {
    sid, userName, ip, credentialId: credentialId || null,
    createdAt: Date.now(), expires: Date.now() + SESSION_TTL_MS,
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, sid + '.json'), JSON.stringify(rec), { mode: 0o600 });
  return rec;
}
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const [sid, sig] = raw.split('.');
  if (!sid || !sig) return null;
  if (!safeEqual(sig, sign(sid))) return null;
  const f = path.join(SESSIONS_DIR, sid + '.json');
  if (!fs.existsSync(f)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (s.expires < Date.now()) { try { fs.unlinkSync(f); } catch {} return null; }
    // A session is only as valid as the passkey behind it: revoke the passkey
    // and every cookie it minted dies on the next request.
    if (s.credentialId) {
      const cred = loadCredentials().find((c) => c.id === s.credentialId);
      if (!cred || credStatus(cred) !== CRED_APPROVED) {
        try { fs.unlinkSync(f); } catch {}
        console.warn(`[dsh-gateway] session ${sid.slice(0, 8)} dropped: passkey revoked/missing`);
        return null;
      }
    }
    // The IP was already being recorded but never looked at. At minimum say so
    // in the log, so a stolen cookie leaves a trace worth grepping for.
    const ip = clientIp(req);
    if (s.ip && ip !== s.ip) {
      if (BIND_SESSION_IP) {
        console.warn(`[dsh-gateway] session ${sid.slice(0, 8)} rejected: ip ${s.ip} -> ${ip}`);
        return null;
      }
      if (s.lastIp !== ip) {
        console.warn(`[dsh-gateway] session ${sid.slice(0, 8)} ip changed: ${s.ip} -> ${ip}`);
        s.lastIp = ip;
        try { fs.writeFileSync(f, JSON.stringify(s), { mode: 0o600 }); } catch {}
      }
    }
    s.expires = Date.now() + SESSION_TTL_MS;
    try { fs.writeFileSync(f, JSON.stringify(s), { mode: 0o600 }); } catch {}
    return s;
  } catch { return null; }
}
function deleteSession(sid) {
  try { fs.unlinkSync(path.join(SESSIONS_DIR, sid + '.json')); } catch {}
}

// ---- periodic disk sweep ----
// Age is the only criterion, deliberately: a just-approved record still has to
// survive long enough for the browser's poll to pick it up and swap it for a
// session. Anything older than the TTL is past being useful either way.
function sweepState() {
  const now = Date.now();
  let pending = 0;
  let sessions = 0;
  const drop = (p) => { try { fs.unlinkSync(p); return 1; } catch { return 0; } };

  try {
    for (const f of fs.readdirSync(PENDING_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(PENDING_DIR, f);
      try {
        const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (now - rec.createdAt > PENDING_TTL_MS) pending += drop(p);
      } catch { pending += drop(p); }   // unparseable → nothing can use it
    }
  } catch {}

  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(SESSIONS_DIR, f);
      try {
        const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (rec.expires < now) sessions += drop(p);
      } catch { sessions += drop(p); }
    }
  } catch {}

  if (pending || sessions) {
    console.log(`[dsh-gateway] sweep: removed ${pending} pending, ${sessions} session file(s)`);
  }
}
setInterval(sweepState, SWEEP_INTERVAL_MS).unref();

function sessionCookie(sid) {
  return serializeCookie(COOKIE_NAME, `${sid}.${sign(sid)}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

// ---- real client IP (behind nginx) ----
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ---- per-device user handle ----
// A passkey is keyed by (rpID, userHandle) inside the authenticator. With one
// fixed handle for every device, registering on the iPhone *replaces* the entry
// in the iCloud keychain that the Mac was using — the server keeps appending
// rows while the client silently drops the old one, leaving ghost credentials.
// Deriving the handle from the device label keeps them independent, and the
// label also shows up in the system passkey picker so they're tellable apart.
function userHandleFor(email, label) {
  return crypto.createHash('sha256').update(`${email}:${label}`).digest();
}

// ============================================================

function deviceRemark(ua) {
  const u = String(ua || '');
  let os = '';
  if (u.indexOf('Macintosh') >= 0) os = 'macOS';
  else if (u.indexOf('iPhone') >= 0) os = 'iOS';
  else if (u.indexOf('iPad') >= 0) os = 'iPadOS';
  else if (u.indexOf('Android') >= 0) os = 'Android';
  else if (u.indexOf('Windows') >= 0) os = 'Windows';
  else if (u.indexOf('Linux') >= 0) os = 'Linux';
  let browser = '';
  if (u.indexOf('Edg/') >= 0) browser = 'Edge';
  else if (u.indexOf('Chrome/') >= 0) browser = 'Chrome';
  else if (u.indexOf('Firefox/') >= 0) browser = 'Firefox';
  else if (u.indexOf('Safari/') >= 0) browser = 'Safari';
  const parts = [];
  if (browser) parts.push(browser);
  if (os) parts.push(os);
  return parts.length ? parts.join(' · ') : '未知设备';
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// serve login page — the displayed host/name follow the configured RP so one
// build serves any deployment (the WebAuthn RP itself comes from the server, so
// these are only the labels the user reads).
const LOGIN_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'login.html'), 'utf8')
  .replaceAll('{{RP_ID}}', RP_ID)
  .replaceAll('{{RP_NAME}}', RP_NAME);
app.get('/auth', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LOGIN_HTML);
});

// ---- auth JSON routes (body parsed per-route to avoid eating proxied bodies) ----
const json = express.json({ limit: '1mb' });

app.post('/auth/register/options', json, async (req, res) => {
  try {
    const label = String(req.body?.label || '').trim().slice(0, 40);
    const email = String(req.body?.email || '').trim().slice(0, 120);
    if (!label) return res.status(400).json({ error: '请先给这个设备起个名字，例如「MacBook」或「iPhone」' });
    // The passkey lives inside some account's keychain (iCloud, Google, Microsoft).
    // WebAuthn never tells the server which one, so the only way to keep a record
    // of where a credential actually resides is to ask.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: '请填写有效的邮箱（Passkey 所在账号，例如 iCloud 账号）' });
    }

    const creds = loadCredentials();
    if (creds.some((c) => c.label && c.label.toLowerCase() === label.toLowerCase()
                       && credStatus(c) !== CRED_REVOKED)) {
      return res.status(400).json({ error: `已有名为「${label}」的 Passkey，换个名字或先删掉旧的` });
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      // Shown in the OS passkey picker. Email is the convention users expect
      // there; the label is what tells two of their devices apart.
      userName: email,
      userDisplayName: `${email} · ${label}`,
      userID: userHandleFor(email, label),
      rpID: RP_ID,
      attestationType: 'none',
      // Only exclude credentials registered under this same handle; excluding
      // every credential would block a second device from enrolling at all.
      excludeCredentials: creds
        .filter((c) => c.label === label)
        .map((c) => ({ id: c.id, transports: c.transports })),
      // 'required' (not 'preferred'): the credential must be discoverable, or
      // it can't show up in the picker during a usernameless sign-in.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = storeChallenge(options.challenge, { label, email });
    res.json({ challengeId, options });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/auth/register/verify', json, async (req, res) => {
  try {
    const { challengeId, response } = req.body || {};
    const rec = takeChallenge(challengeId);
    if (!rec) return res.status(400).json({ error: 'expired or unknown challenge' });
    const label = rec.meta?.label || '';
    const email = rec.meta?.email || '';
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: rec.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
    if (!v.verified) return res.status(400).json({ error: 'verification failed' });
    const { credential, credentialDeviceType, credentialBackedUp, aaguid } = v.registrationInfo;
    const creds = loadCredentials().filter((c) => c.id !== credential.id);
    creds.push({
      id: credential.id,
      publicKey: b64u.encode(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
      userName: USER_NAME,
      label,
      email,
      // New passkeys are untrusted until a human with terminal access says so.
      status: CRED_PENDING,
      approvedAt: null,
      // Metadata worth keeping so a row in credentials.json is identifiable:
      //   aaguid      — authenticator model (iCloud Keychain, Windows Hello, YubiKey…)
      //   deviceType  — 'multiDevice' means it syncs; 'singleDevice' is stuck on that machine
      //   backedUp    — whether the provider actually has it backed up
      aaguid: aaguid || null,
      deviceType: credentialDeviceType || null,
      backedUp: Boolean(credentialBackedUp),
      registeredUA: String(req.headers['user-agent'] || '').slice(0, 200),
      remark: deviceRemark(String(req.headers['user-agent'] || '')),
      registeredIp: clientIp(req),
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    saveCredentials(creds);
    console.log(`[dsh-gateway] passkey registered (pending approval): label=${label} email=${email} ip=${clientIp(req)}`);
    res.json({ ok: true, label, email, status: CRED_PENDING });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/auth/login/options', json, async (req, res) => {
  try {
    const creds = loadCredentials();
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      // Deliberately NOT sending allowCredentials. Listing specific IDs limits
      // the picker to those entries, and a credential registered on another
      // machine (transports:['internal'], never synced) simply won't match —
      // which is exactly why signing in from the phone got stuck. Leaving it
      // empty lets the platform offer every passkey it actually holds for
      // this RP, which is the whole point of discoverable credentials.
      userVerification: 'preferred',
    });
    const challengeId = storeChallenge(options.challenge);
    res.json({ challengeId, options, hasCredentials: creds.length > 0 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/auth/login/verify', json, async (req, res) => {
  try {
    const { challengeId, response } = req.body || {};
    const rec = takeChallenge(challengeId);
    if (!rec) return res.status(400).json({ error: 'expired or unknown challenge' });
    const creds = loadCredentials();
    const stored = creds.find((c) => c.id === response?.id);
    // A ghost credential: the server has the row but the authenticator replaced
    // it (same rpID + userHandle). Say so plainly instead of "unknown credential".
    if (!stored) {
      return res.status(400).json({
        error: '这个 Passkey 服务器上没有记录，可能已被同名注册覆盖。请重新注册一个（换个设备名）。',
      });
    }
    const credential = {
      id: stored.id,
      publicKey: b64u.decode(stored.publicKey),
      counter: stored.counter,
      transports: stored.transports,
    };
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: rec.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential,
      requireUserVerification: false,
    });
    if (!v.verified) return res.status(400).json({ error: 'verification failed' });

    const ip = clientIp(req);
    const state = credStatus(stored);
    if (state === CRED_REVOKED) {
      console.warn(`[dsh-gateway] sign-in refused: passkey "${stored.label || stored.id}" is revoked (ip=${ip})`);
      return res.status(403).json({ error: '这个 Passkey 已被吊销，请用其它设备登录，或重新注册一个。' });
    }

    // update counter + usage trail
    stored.counter = v.authenticationInfo.newCounter;
    stored.lastUsedAt = Date.now();
    stored.lastUsedIp = ip;
    saveCredentials(creds);

    if (state === CRED_APPROVED) {
      // Trusted passkey — no terminal round trip. Proving the passkey again
      // after the session expires is exactly this path, which is why session
      // expiry doesn't drag a human back to the server.
      const sess = createSession(USER_NAME, ip, stored.id);
      res.setHeader('Set-Cookie', sessionCookie(sess.sid));
      console.log(`[dsh-gateway] sign-in ok: "${stored.label || '(unnamed)'}" ip=${ip} (trusted passkey)`);
      return res.json({ status: 'ok' });
    }

    // Not trusted yet: park the login until someone approves the *passkey*.
    const pending = createPending({
      credentialId: stored.id,
      email: stored.email,
      label: stored.label,
      userName: USER_NAME,
      ip,
      ua: req.headers['user-agent'] || '',
    });
    console.log(`[dsh-gateway] sign-in parked: passkey "${stored.label || stored.id}" awaits approval (ip=${ip})`);
    res.json({ status: 'pending', token: pending.token, label: stored.label || '' });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// poll for terminal approval status
// Poll target: reports the state of the *passkey* this login is waiting on.
app.get('/auth/status', (req, res) => {
  const token = req.query.token;
  const p = getPending(token);
  if (!p || !p.credentialId) return res.json({ status: 'notfound' });

  const cred = loadCredentials().find((c) => c.id === p.credentialId);
  if (!cred) { deletePending(token); return res.json({ status: 'notfound' }); }

  const state = credStatus(cred);
  if (state === CRED_REVOKED) { deletePending(token); return res.json({ status: 'denied' }); }
  if (state === CRED_APPROVED) {
    deletePending(token);
    const sess = createSession(p.userName, p.ip, cred.id);
    res.setHeader('Set-Cookie', sessionCookie(sess.sid));
    console.log(`[dsh-gateway] sign-in ok: "${cred.label || '(unnamed)'}" ip=${p.ip} (passkey just approved)`);
    return res.json({ status: 'approved' });
  }
  res.json({ status: 'pending' });
});

app.post('/auth/logout', (req, res) => {
  const s = getSession(req);
  if (s) deleteSession(s.sid);
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 }));
  res.json({ ok: true });
});

// ---- proxy middleware (authenticated only) ----
const proxy = httpProxy.createProxyServer({});
proxy.on('error', (err, req, res) => {
  console.error('[dsh-gateway] proxy error:', err.message);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway');
  } else if (res && typeof res.end === 'function') {
    res.end();
  }
});

app.use((req, res) => {
  const sess = getSession(req);
  if (!sess) return res.redirect('/auth');
  res.setHeader('Set-Cookie', sessionCookie(sess.sid));
  proxy.web(req, res, { target: DSH_TARGET });
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const sess = getSession(req);
  if (!sess) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: DSH_TARGET });
});

server.listen(PORT, HOST, () => {
  sweepState();   // clear anything left over from a previous run
  console.log(`[dsh-gateway] listening on http://${HOST}:${PORT} -> ${DSH_TARGET} (RP=${RP_ID})`);
  console.log(`[dsh-gateway] approval unit = passkey · session TTL ${SESSION_TTL_MS / 3600000}h · ip-binding ${BIND_SESSION_IP ? 'on' : 'off'}`);
  const waiting = loadCredentials().filter((c) => credStatus(c) === CRED_PENDING);
  if (waiting.length) {
    console.log(`[dsh-gateway] ${waiting.length} passkey(s) awaiting approval — run: dsh-approve list`);
  }
});
