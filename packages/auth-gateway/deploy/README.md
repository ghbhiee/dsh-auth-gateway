# macOS deployment (launchd)

Registers two per-user launchd services so a passkey-gated `dsh web` survives
logout, reboot, and crashes:

| Service | Label | What it runs |
|---|---|---|
| dsh web | `com.tokencv.dsh-web` | `dsh --profile web --host 127.0.0.1 --port 3080 --trusted-host <domain>` |
| gateway | `com.tokencv.dsh-gateway` | `node server.js` (passkey reverse proxy → dsh) |

nginx and frpc are **not** managed here — they run as `brew services`. Point your
public entry (nginx → `127.0.0.1:3090`, then frp) at the gateway, never at dsh.

## Install / update (idempotent)

```sh
./install-macos.sh
```

Re-run any time; it rewrites the plists and re-bootstraps in place. Every knob has
a default matching the `mac.tokencv.com` deployment — override by exporting first:

```sh
DSH_GW_RP_ID=ds.example.com DSH_TRUSTED_HOST=ds.example.com ./install-macos.sh
```

| Env | Default | Meaning |
|---|---|---|
| `DSH_PROFILE` | `web` | dsh profile to serve |
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | dsh web bind |
| `DSH_TRUSTED_HOST` | `mac.tokencv.com` | dsh `--trusted-host` |
| `DSH_WORKDIR` | `$HOME` | dsh working directory (its file root) |
| `DSH_GW_HOST` / `DSH_GW_PORT` | `127.0.0.1` / `3090` | gateway bind |
| `DSH_GW_TARGET` | `http://127.0.0.1:$DSH_PORT` | where the gateway proxies |
| `DSH_GW_RP_ID` | `mac.tokencv.com` | WebAuthn RP ID (**must equal the public domain**) |
| `DSH_GW_STATE_DIR` | `~/.dsh-gateway/state` | passkeys + sessions |
| `DSH_BIN` / `NODE_BIN` | from `PATH` | binary overrides |

The gateway's own dependencies (`npm ci`) are installed automatically on first run
if `node_modules` is missing.

## Uninstall

```sh
./uninstall-macos.sh            # stop + remove services, keep passkeys/sessions
./uninstall-macos.sh --purge    # also delete ~/.dsh-gateway/state
```

## Operate

```sh
launchctl kickstart -k gui/$(id -u)/com.tokencv.dsh-web       # restart dsh
launchctl kickstart -k gui/$(id -u)/com.tokencv.dsh-gateway   # restart gateway
launchctl print       gui/$(id -u)/com.tokencv.dsh-gateway    # full status
tail -f ~/Library/Logs/dsh-web.log ~/Library/Logs/dsh-gateway.log
dsh-approve list                                              # approve a passkey
```
