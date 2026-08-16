#!/usr/bin/env node
'use strict';
/*
 * dsh-approve — terminal trust management for the dsh auth gateway.
 *
 * The unit of approval is the PASSKEY, not the login. Approve a passkey once
 * and that device signs in on its own from then on; the session TTL only
 * controls how often the browser must re-prove the passkey (no terminal
 * round trip). Revoke the passkey to cut it off — that also kills any session
 * it produced.
 *
 * Usage:
 *   dsh-approve list                 passkeys awaiting approval (default)
 *   dsh-approve passkeys             all passkeys with status
 *   dsh-approve approve <id|label>   trust a passkey — it can sign in from now on
 *   dsh-approve reject <id|label>    refuse a not-yet-trusted passkey (deletes it)
 *   dsh-approve revoke <id|label>    withdraw trust from an approved passkey
 *   dsh-approve sessions             active browser sessions
 *   dsh-approve session-revoke <sid> drop one session (passkey stays trusted)
 *   dsh-approve cleanup              remove expired pending logins / sessions
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Must resolve to the SAME directory the server writes — set DSH_GW_STATE_DIR
// identically for both (systemd/launchd for the server, your shell for this CLI).
const STATE_DIR = process.env.DSH_GW_STATE_DIR || path.join(os.homedir(), '.dsh-gateway', 'state');
const PENDING_DIR = path.join(STATE_DIR, 'pending');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const CREDENTIALS_FILE = path.join(STATE_DIR, 'credentials.json');
// Must match PENDING_TTL_MS in server.js.
const PENDING_TTL_MS = 30 * 60 * 1000;

const CRED_PENDING = 'pending';
const CRED_APPROVED = 'approved';
const CRED_REVOKED = 'revoked';
// Rows written before the trust model existed have no status; server.js treats
// those as approved, so this must agree or the two would disagree about access.
const statusOf = (c) => c.status || CRED_APPROVED;

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function readCredentials() { return readJson(CREDENTIALS_FILE, []); }
function saveCredentials(list) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}
function readDir(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(dir, f), null)).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
const readPending = () => readDir(PENDING_DIR);
const readSessions = () => readDir(SESSIONS_DIR);
const drop = (p) => { try { fs.unlinkSync(p); return true; } catch { return false; } };

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtTime(ts) {
  if (!ts) return '(n/a)';
  // 服务器时区是 US/Eastern，用户在 GMT+8，必须显式指定时区
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

// Find a credential by full id, id prefix, or label — typing 43 chars of
// base64 to approve your own phone is not a security feature.
function findCred(creds, needle) {
  const exact = creds.filter((c) => c.id === needle || c.label === needle);
  if (exact.length === 1) return { cred: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const fuzzy = creds.filter((c) => c.id.startsWith(needle)
    || (c.label && c.label.toLowerCase().includes(needle.toLowerCase())));
  if (fuzzy.length === 1) return { cred: fuzzy[0] };
  if (fuzzy.length > 1) return { ambiguous: fuzzy };
  return {};
}

function killSessionsFor(credId) {
  let n = 0;
  for (const s of readSessions()) {
    if (s.credentialId === credId && drop(path.join(SESSIONS_DIR, s.sid + '.json'))) n++;
  }
  return n;
}

function describe(c) {
  const st = statusOf(c);
  const badge = st === CRED_APPROVED ? '✓ 已信任'
              : st === CRED_PENDING ? '● 待批准'
              : '✕ 已吊销';
  const kind = c.deviceType === 'multiDevice' ? '云同步'
             : c.deviceType === 'singleDevice' ? '仅本机'
             : '未知';
  console.log(`  ${badge}  ${c.label || '(未命名 — 旧版本注册)'}`);
  console.log(`     邮箱      ${c.email || '(旧版本注册，无记录)'}`);
  console.log(`     id        ${c.id}`);
  console.log(`     类型      ${kind}${c.backedUp ? ' · 已备份' : ''}  transports=${(c.transports || []).join(',') || '(none)'}`);
  console.log('     备注      ' + (c.remark || '—'));
  console.log(`     注册      ${fmtTime(c.createdAt)}${c.registeredIp ? '  ip=' + c.registeredIp : ''}`);
  if (c.approvedAt) console.log(`     批准      ${fmtTime(c.approvedAt)}`);
  console.log(`     最后登录  ${c.lastUsedAt ? fmtTime(c.lastUsedAt) + (c.lastUsedIp ? '  ip=' + c.lastUsedIp : '') : '从未'}`);
  if (c.registeredUA) console.log(`     UA        ${c.registeredUA.slice(0, 68)}`);
  console.log('');
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest[0];

function bail(msg, code = 1) { console.log(msg); process.exit(code); }
function resolveOrBail(creds, needle) {
  const { cred, ambiguous } = findCred(creds, needle);
  if (ambiguous) {
    console.log(`"${needle}" 匹配到多个 Passkey，请用更精确的 id 或 label：`);
    for (const c of ambiguous) console.log(`  ${c.label || '(未命名)'}  ${c.id}`);
    process.exit(1);
  }
  if (!cred) bail(`找不到匹配 "${needle}" 的 Passkey。用 'dsh-approve passkeys' 查看全部。`);
  return cred;
}

// ---------------------------------------------------------------- list
if (!cmd || cmd === 'list') {
  const creds = readCredentials();
  const waiting = creds.filter((c) => statusOf(c) === CRED_PENDING);
  const logins = readPending();

  if (waiting.length === 0) {
    console.log('没有待批准的 Passkey。');
    const approved = creds.filter((c) => statusOf(c) === CRED_APPROVED).length;
    console.log(`(已信任 ${approved} 个 · 'dsh-approve passkeys' 查看全部)`);
    process.exit(0);
  }

  console.log('待批准的 Passkey：\n');
  for (const c of waiting) {
    describe(c);
    const waitingLogin = logins.find((p) => p.credentialId === c.id);
    if (waitingLogin) {
      console.log(`     ⏳ 有一个浏览器正在等待（${ago(waitingLogin.createdAt)}，ip=${waitingLogin.ip}）\n`);
    }
  }
  console.log('批准： dsh-approve approve <label 或 id 前缀>');
  console.log('拒绝： dsh-approve reject  <label 或 id 前缀>');
  process.exit(0);
}

// ---------------------------------------------------------------- passkeys
if (cmd === 'passkeys' || cmd === 'credentials') {
  const creds = readCredentials();
  if (creds.length === 0) bail('还没有注册任何 Passkey。', 0);
  console.log('全部 Passkey：\n');
  for (const c of creds) describe(c);
  const n = (s) => creds.filter((c) => statusOf(c) === s).length;
  console.log(`(共 ${creds.length} 个：已信任 ${n(CRED_APPROVED)} · 待批准 ${n(CRED_PENDING)} · 已吊销 ${n(CRED_REVOKED)})`);
  process.exit(0);
}

// ---------------------------------------------------------------- approve
if (cmd === 'approve') {
  if (!arg) bail('用法: dsh-approve approve <label 或 id 前缀>');
  const creds = readCredentials();
  const cred = resolveOrBail(creds, arg);
  const st = statusOf(cred);
  if (st === CRED_APPROVED) bail(`「${cred.label || cred.id}」已经是信任状态了。`, 0);
  if (st === CRED_REVOKED) bail(`「${cred.label || cred.id}」已被吊销。要恢复请让用户重新注册。`);
  cred.status = CRED_APPROVED;
  cred.approvedAt = Date.now();
  saveCredentials(creds);
  console.log(`✓ 已信任 Passkey「${cred.label || cred.id}」（${cred.email || '无邮箱记录'}）`);
  console.log('  该设备从现在起可以自行登录，无需再来终端批准。');
  console.log('  正在等待的浏览器会在 1~2 秒内自动进入。');
  process.exit(0);
}

// ---------------------------------------------------------------- reject
if (cmd === 'reject' || cmd === 'deny') {
  if (!arg) bail(`用法: dsh-approve ${cmd} <label 或 id 前缀>`);
  const creds = readCredentials();
  const cred = resolveOrBail(creds, arg);
  if (statusOf(cred) === CRED_APPROVED) {
    bail(`「${cred.label || cred.id}」已是信任状态，要收回请用 'dsh-approve revoke'。`);
  }
  const left = creds.filter((c) => c.id !== cred.id);
  saveCredentials(left);
  const killed = killSessionsFor(cred.id);
  console.log(`✕ 已拒绝并删除 Passkey「${cred.label || cred.id}」${killed ? `，同时断开 ${killed} 个会话` : ''}`);
  console.log('  提示：设备上的 Passkey 需要用户自己在系统设置里删除。');
  process.exit(0);
}

// ---------------------------------------------------------------- revoke
if (cmd === 'revoke') {
  if (!arg) bail('用法: dsh-approve revoke <label 或 id 前缀>');
  const creds = readCredentials();
  const cred = resolveOrBail(creds, arg);
  if (statusOf(cred) === CRED_REVOKED) bail(`「${cred.label || cred.id}」已经是吊销状态。`, 0);
  cred.status = CRED_REVOKED;
  cred.revokedAt = Date.now();
  saveCredentials(creds);
  const killed = killSessionsFor(cred.id);
  console.log(`✕ 已吊销 Passkey「${cred.label || cred.id}」${killed ? `，并断开 ${killed} 个会话` : ''}`);
  console.log('  它再也无法登录。彻底清除请用 reject，或让用户在设备上删掉。');
  process.exit(0);
}

// ---------------------------------------------------------------- sessions
if (cmd === 'sessions') {
  const items = readSessions();
  if (items.length === 0) bail('当前没有活跃会话。', 0);
  const creds = readCredentials();
  console.log('活跃会话：\n');
  for (const s of items) {
    const cred = creds.find((c) => c.id === s.credentialId);
    const expired = s.expires < Date.now();
    console.log(`  ${s.sid}${expired ? '  [已过期]' : ''}`);
    console.log(`     来自      ${cred ? (cred.label || '(未命名)') : '(旧会话，无 passkey 记录)'}  ip=${s.ip}`);
    console.log(`     登录于    ${fmtTime(s.createdAt)}  (${ago(s.createdAt)})`);
    console.log(`     过期      ${fmtTime(s.expires)}\n`);
  }
  console.log(`(共 ${items.length} 个 · 'dsh-approve session-revoke <sid>' 断开单个)`);
  process.exit(0);
}

if (cmd === 'session-revoke') {
  if (!arg) bail('用法: dsh-approve session-revoke <sid>');
  const hit = readSessions().find((s) => s.sid === arg || s.sid.startsWith(arg));
  if (!hit) bail(`找不到会话 ${arg}`);
  drop(path.join(SESSIONS_DIR, hit.sid + '.json'));
  console.log(`已断开会话 ${hit.sid}`);
  console.log('（该 Passkey 仍是信任状态，用户可以直接重新登录。要禁掉设备请用 revoke。）');
  process.exit(0);
}

// ---------------------------------------------------------------- cleanup
if (cmd === 'cleanup') {
  let logins = 0;
  for (const p of readPending()) {
    if (Date.now() - p.createdAt > PENDING_TTL_MS) {
      if (drop(path.join(PENDING_DIR, p.token + '.json'))) logins++;
    }
  }
  let sess = 0;
  for (const s of readSessions()) {
    if (s.expires < Date.now() && drop(path.join(SESSIONS_DIR, s.sid + '.json'))) sess++;
  }
  console.log(`清理完成：${logins} 个过期登录请求，${sess} 个过期会话。`);
  console.log('（网关每 10 分钟也会自动做一次，通常不用手动跑。）');
  process.exit(0);
}

console.log(`未知命令: ${cmd}`);
console.log('用法: dsh-approve [list|passkeys|approve <id>|reject <id>|revoke <id>|sessions|session-revoke <sid>|cleanup]');
process.exit(1);
