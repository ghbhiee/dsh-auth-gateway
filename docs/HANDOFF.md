# Handoff — dsh-auth-gateway

Continuation brief for a fresh session working on this repo. Read this, then
`~/dsh/OPS-dsh.md` (install/restart/upgrade runbook) and, for history,
`~/dsh/PLAN-dsh-plugins.md` (local machine only, NOT in git). Public repo:
keep secrets out.


## Working agreement — git is the source of truth

This repo is edited from more than one place: a parked continuation session for
this repo, and whichever session the user happens to be in. That drifted once —
the same repo had uncommitted work in one place while another session was
building on top of it — so:

**Commit and push as soon as a change is finished. Do not leave finished work
sitting uncommitted, and never assume the working tree is what git has.**

Before starting anything: `git pull` (or at minimum `git status && git log --oneline -3`).
Whatever is on `main` is what everyone else — and every `github:` install —
sees. Whatever is on `main` is what a deploy pulls.

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

## Deployment reality (server 15 — `ds.tokencv.com`)

`ds.tokencv.com` → nginx → **gateway :3090** → dsh web :3080, run by systemd
(`dsh-gateway.service`, `WorkingDirectory=/opt/dsh-gateway`). Six passkeys are
registered here.

**Its state dir is `/opt/dsh-gateway/state`, not the `~/.dsh-gateway/state`
default** — kept there by a systemd drop-in:

```
/etc/systemd/system/dsh-gateway.service.d/override.conf
  [Service]
  Environment=DSH_GW_STATE_DIR=/opt/dsh-gateway/state
```

That drop-in is load-bearing. Until 2026-08-18 the server ran a *forked*
`server.js` with the paths hardcoded and no git checkout at all; deploying
this repo over it without the override would have sent the gateway looking for
credentials in an empty directory — every passkey dead, nobody able to log in.
The fork is gone (the directory is now a real checkout of `main`), but check
the drop-in still exists before believing an upgrade is safe.

Updating is now ordinary git:

```sh
ssh root@15.tokencv.com   # DNS is flaky; 193.22.152.136 works directly
cd /opt/dsh-gateway && git pull
npm ci --omit=dev                        # only when dependencies changed
systemctl restart dsh-gateway.service
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3090/     # 302 = up
python3 -c "import json;print(len(json.load(open('state/credentials.json'))))"
```

Untracked and therefore safe across checkouts: `state/`, `node_modules/`, and
the `server.js.bak-*` snapshots from the pre-git era. A tarball of the
pre-migration tree sits at `/root/dsh-gateway-backup-20260818-230834.tar.gz`.

## Constraints / cautions

- Keep it dependency-light and buildless; `npm run check` is `node --check`
  on both entry points, and CI runs `npm ci && npm run check`.
- Never log or commit credential material; the state dir stays outside the
  repo. The repo is public.
- Config is env-only (no config file) so the launchd plist stays the single
  source of deployment truth; add new knobs as `DSH_GW_*` variables with
  sensible defaults.
- Cookie/session semantics and the WebAuthn RP ID (`mac.tokencv.com` here,
  `ds.tokencv.com` on server 15) are deployment-coupled: changing the public
  hostname means a new RP ID and re-registering passkeys.
- **Before deploying anywhere, diff the target's `server.js` against the
  commit you are about to install.** Both live deployments predate this repo's
  env-driven config; one of them still had hardcoded paths in 2026-08-18. A
  deployment that silently relocates `STATE_DIR` locks everyone out. Trial-run
  the new code on a spare port against a *copy* of the state dir first.

## Verify

```sh
node --check server.js && node --check bin/dsh-approve.js
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3090/   # 302 = up
```
