'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Integration: a real gateway process on a scratch port with scratch state,
// proxying to a stub dsh. The passkey ceremony is out of scope (it needs an
// authenticator); the browser's outcome — a session file plus its signed
// cookie — is forged directly against the same SECRET the server minted.

const ROOT = path.join(__dirname, '..');
const PORT = 39_000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let stateDir;
let gateway;
let stubDsh;
let stubPort;

function request(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      ORIGIN + pathname,
      { method, headers, timeout: 5000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function forgeSessionCookie() {
  // Same shapes the server uses: session file + sid.hmac cookie.
  const secret = fs.readFileSync(path.join(stateDir, 'secret'), 'utf8').trim();
  const sid = crypto.randomUUID();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', sid + '.json'),
    JSON.stringify({
      sid,
      userName: 'herb',
      ip: '127.0.0.1',
      credentialId: null,
      createdAt: Date.now(),
      expires: Date.now() + 3600_000,
    }),
    { mode: 0o600 }
  );
  const sig = crypto.createHmac('sha256', secret).update(sid).digest('base64url');
  return `dsh_auth=${sid}.${sig}`;
}

before(async () => {
  stubDsh = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<script>window.__DSH_BOOT__={}</script>stub dsh');
  });
  await new Promise((resolve) => stubDsh.listen(0, '127.0.0.1', resolve));
  stubPort = stubDsh.address().port;

  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-test-'));
  gateway = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      DSH_GW_HOST: '127.0.0.1',
      DSH_GW_PORT: String(PORT),
      DSH_GW_STATE_DIR: stateDir,
      DSH_GW_TARGET: `http://127.0.0.1:${stubPort}`,
      DSH_GW_RP_ID: 'localhost',
      DSH_GW_ORIGIN: ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway never listened')), 15_000);
    gateway.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

after(() => {
  gateway?.kill('SIGTERM');
  stubDsh?.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('unauthenticated requests cannot mint pairing codes', async () => {
  const res = await request('/auth/pair/code', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('the full pairing round trip: code → claim → proxied dsh', async () => {
  const browserCookie = forgeSessionCookie();

  const minted = await request('/auth/pair/code', {
    method: 'POST',
    headers: { cookie: browserCookie },
  });
  assert.equal(minted.status, 200);
  const { code } = JSON.parse(minted.body);
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);

  const claimed = await request('/auth/pair/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(claimed.status, 200);
  const parsed = JSON.parse(claimed.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cookie.name, 'dsh_auth');
  assert.ok(parsed.cookie.expires > Date.now() / 1000);

  // The claimed cookie opens the proxied dsh.
  const proxied = await request('/', {
    headers: { cookie: `dsh_auth=${parsed.cookie.value}` },
  });
  assert.equal(proxied.status, 200);
  assert.match(proxied.body, /__DSH_BOOT__/);

  // Single-use: the same code never claims twice.
  const again = await request('/auth/pair/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(again.status, 400);
});

test('junk and malformed codes are refused', async () => {
  for (const code of ['', 'short', 'AAAAAAA0', 'NOTACODE'.toLowerCase(), 'ZZZZZZZZ']) {
    const res = await request('/auth/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert.equal(res.status, 400, `code ${JSON.stringify(code)} should be refused`);
  }
});
