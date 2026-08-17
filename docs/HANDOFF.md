# Handoff — dsh-auth-gateway

Continuation brief for a fresh session working on this repo. Read this, then
`~/dsh/OPS-dsh.md` (install/restart/upgrade runbook) and, for history,
`~/dsh/PLAN-dsh-plugins.md` (local machine only, NOT in git). Public repo:
keep secrets out.

## What this is

A passkey (WebAuthn) reverse-proxy **companion service** that guards a
DeepSeek Harness web app. Plain CommonJS Node (express 5 +
@simplewebauthn/server + http-proxy), no build step, no framework. It is
deliberately NOT a dsh/cordis plugin: dsh's webServer has only named routes
plus one core-owned fallback and no middleware seam, so a plugin cannot gate
the whole app — hence a proxy in front.

This repository used to be the `dsh-plugins` monorepo; the three plugins now
live in their own repos (`dsh-plugin-workbench`, `dsh-plugin-mobile-shell`,
`dsh-plugin-cli-session` — see the README's "Where the plugins went" table).
Old `dsh-plugins` URLs redirect here. The old v0.1.0/v0.2.0 plugin-tarball
releases remain attached to this repo's history.

## Architecture

- `server.js` — everything: WebAuthn register/login ceremonies, session
  cookies, the allow-list of approved credentials, and the proxy pass-through
  to the dsh target. Reads config from `DSH_GW_*` environment variables
  (host/port/target/rp-id/state dir) — set by the launchd plist.
- `bin/dsh-approve.js` — operator CLI: `dsh-approve list` / `approve <label>`
  to admit a newly registered passkey.
- `public/` — the login page served to unauthenticated visitors.
- `deploy/install-macos.sh` / `uninstall-macos.sh` — idempotent launchd
  installers for BOTH services (`com.tokencv.dsh-gateway`,
  `com.tokencv.dsh-web`). They derive paths from their own location, so after
  moving the checkout, re-running install rewrites the plists.

## Deployment reality (this Mac)

`mac.tokencv.com` → (server-12 nginx TLS) → frp → local nginx:8080 →
**gateway :3090** → dsh web :3080. Unauthenticated requests 302 to the login
page; passkey state (credentials, sessions) lives in `~/.dsh-gateway/state`
and survives reinstall/upgrade. Logs: `~/Library/Logs/dsh-gateway.log`.

**This service is the login wall for the public dsh** — while it is down,
remote access is down. Restart deliberately:
`launchctl kickstart -k gui/$(id -u)/com.tokencv.dsh-gateway`.

## Constraints / cautions

- Keep it dependency-light and buildless; `npm run check` is `node --check`
  on both entry points, and CI runs `npm ci && npm run check`.
- Never log or commit credential material; the state dir stays outside the
  repo. The repo is public.
- Config is env-only (no config file) so the launchd plist stays the single
  source of deployment truth; add new knobs as `DSH_GW_*` variables with
  sensible defaults.
- Cookie/session semantics and the WebAuthn RP ID (`mac.tokencv.com`) are
  deployment-coupled: changing the public hostname means a new RP ID and
  re-registering passkeys.

## Verify

```sh
node --check server.js && node --check bin/dsh-approve.js
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3090/   # 302 = up
```
