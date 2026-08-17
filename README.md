# dsh-auth-gateway

## Where the plugins went

This repository used to be a monorepo that also carried the dsh plugins. Each
plugin now lives (and is developed) in its own repository, installable straight
from GitHub:

| Plugin | Repo | Install |
|---|---|---|
| workbench (files + preview + terminal panel) | [dsh-plugin-workbench](https://github.com/ghbhiee/dsh-plugin-workbench) | `dsh plugin --profile web add github:ghbhiee/dsh-plugin-workbench` |
| mobile-shell (narrow-viewport drawer shell) | [dsh-plugin-mobile-shell](https://github.com/ghbhiee/dsh-plugin-mobile-shell) | `dsh plugin --profile web add github:ghbhiee/dsh-plugin-mobile-shell` |
| cli-session (headless CLI runner) | [dsh-plugin-cli-session](https://github.com/ghbhiee/dsh-plugin-cli-session) | `dsh plugin --profile chat add github:ghbhiee/dsh-plugin-cli-session` |

A passkey (WebAuthn) reverse proxy that guards a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web app.

> **Not a cordis plugin — a companion process.** dsh's webserver exposes only
> named routes and a single fallback (owned by the core app); there is no
> middleware or global gate a plugin could use to guard the UI, RPC, and event
> websockets. So authentication has to sit *in front of* `dsh web`, which is
> what this does.

## Flow

```
browser ──TLS──> nginx ──> dsh-auth-gateway ──(authed only)──> dsh web (127.0.0.1:3080)
                                │
                                └─ passkey register → pending → `dsh-approve` in a terminal → session cookie
```

A freshly registered passkey is **pending** until someone with shell access runs
`dsh-approve approve <label>`. After that it signs in on its own until revoked.
The unit of trust is the passkey, not the login, so an expired session cookie is
refreshed by re-proving the passkey — no second terminal round trip.

## Run

```sh
npm install
DSH_GW_RP_ID=example.com DSH_GW_STATE_DIR=/var/lib/dsh-gateway/state node server.js
```

Then point nginx (which terminates TLS for `DSH_GW_RP_ID`) at `127.0.0.1:3090`,
forwarding `Host`, `Origin`, and `X-Forwarded-For`.

## Configuration (environment)

| Var | Default | Meaning |
|---|---|---|
| `DSH_GW_RP_ID` | `ds.tokencv.com` | WebAuthn Relying Party ID — the exact public host in the address bar. Passkeys are scoped to it. |
| `DSH_GW_ORIGIN` | `https://<RP_ID>` | Expected origin of WebAuthn responses. |
| `DSH_GW_RP_NAME` | `DeepSeek Harness` | Display name in the OS passkey picker and login page. |
| `DSH_GW_TARGET` | `http://127.0.0.1:3080` | The dsh web app to proxy authed traffic to. |
| `DSH_GW_HOST` / `DSH_GW_PORT` | `127.0.0.1` / `3090` | Where the gateway listens. |
| `DSH_GW_STATE_DIR` | `~/.dsh-gateway/state` | Credentials, sessions, signing secret. **`dsh-approve` must be given the same value.** |
| `DSH_GW_PUBLIC_DIR` | `<pkg>/public` | Login page assets. |
| `DSH_GW_USER_NAME` / `DSH_GW_USER_DISPLAY` | `herb` / `Herb` | The single account passkeys enrol under. |
| `DSH_GW_COOKIE_NAME` | `dsh_auth` | Session cookie name. |
| `DSH_SESSION_TTL_HOURS` | `24` | Cookie freshness before the passkey must be re-proven. |
| `DSH_BIND_SESSION_IP` | `0` | `1` refuses a cookie replayed from a different IP (off by default — roaming changes IPs). |

## Terminal trust management

`dsh-approve` (run with the same `DSH_GW_STATE_DIR`) manages which passkeys are trusted:

```
dsh-approve list                  passkeys awaiting approval (default)
dsh-approve passkeys              all passkeys with status
dsh-approve approve <id|label>    trust a passkey — it can sign in from now on
dsh-approve reject  <id|label>    refuse a not-yet-trusted passkey (deletes it)
dsh-approve revoke  <id|label>    withdraw trust; every session it minted dies too
dsh-approve sessions             active browser sessions
dsh-approve session-revoke <sid> drop one session (passkey stays trusted)
dsh-approve cleanup              remove expired pending logins / sessions
```
