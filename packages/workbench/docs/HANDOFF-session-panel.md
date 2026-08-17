# Handoff — workbench as a session-docked, context-aware panel

Continuation brief for a fresh session. Read this, then `~/dsh/PLAN-dsh-plugins.md`
(full design + 22-item pitfall list) and the memory note `project_dsh_plugins`.

## Where the project stands (summary)

Four packages in `~/dsh/plugins` (pnpm workspace; `pnpm run check` = typecheck →
vitest → tsdown build; **318 tests green**), published to
<https://github.com/ghbhiee/dsh-plugins> (release v0.1.0, CI green):

- **workbench** — file browser + preview/edit + raw-PTY terminal, on ONE
  full-frame surface seated in `shell.overlay`. Host routes under
  `/plugins/workbench/api/*` + WS `/plugins/workbench/pty`.
- **mobile-shell** — narrow drawer/swipe/title, keyed on stable data attributes.
- **cli-session** — resume-capable headless CLI runner.
- **auth-gateway** — passkey (WebAuthn) reverse-proxy *companion* (NOT a cordis
  plugin — see constraint below). Deployed on this Mac; `deploy/install-macos.sh`
  registers the launchd services.

Live deployment: `https://mac.tokencv.com` → (12 nginx TLS) → frp → local nginx:8080
→ gateway:3090 (passkey) → `dsh --profile web` :3080. dsh is **npm global
`@deepseek-ai/dsh@0.1.0-rc.6`** (already latest; not git-built). Plugins verified
compatible with rc.6.

Key files (client half): `packages/workbench/src/client/` —
`WorkbenchOverlay.tsx` (the surface + Files/Terminal tablist), `FileBrowser.tsx`,
`FilePreview.tsx`, `TerminalPane.tsx`, `api.ts`, `preview-kind.ts`. Host half:
`src/{index,api,pty,roots,write-guard,search,origin}.ts`.

## The task (3 features)

### 1. Dock the workbench on the RIGHT of the session (not full-frame)
Today it renders full-frame in `shell.overlay`. Goal: a side panel beside the
active conversation, so you see chat + files/terminal together.

- **Seat reality (already scouted):** the host exposes only `shell.overlay`
  (full-frame, list), `sidebar.footer.action`, and `conversation.{view,chat.node,
  composer.bar}`. **There is no dedicated "session aside" seat.** A plugin can
  only render where the host provides a seat, so a true dock likely can't be a
  new seat.
- **Most promising approach:** mirror `mobile-shell` — keep rendering in
  `shell.overlay`, but instead of covering the frame, position the panel as a
  right-hand dock with CSS keyed on the layout's **stable data attributes** (the
  AppFrame is the parent of `[data-shell-overlay]`; mobile-shell already restyles
  those columns). Add a resizable split so chat keeps its width. Verify which
  data attributes the conversation column exposes; do NOT key on hash CSS-module
  class names (pitfall #12-adjacent — they change every build).
- Consider a toggle: full-frame ↔ docked. The launcher is in
  `sidebar.footer.action`.

### 2. Link to the current session's directory
- **File browser root = the active session's cwd.** Each dsh session has a
  working directory; find how the client exposes the active session + its cwd
  (investigate the client runtime / session store — grep the ui-conversation /
  runtime packages for the active-session selector and a `cwd`/`workspaceRoot`
  field). The host already composes roots from
  `ctx.sandboxPolicy.resolve().workspaceRoot` (`roots.ts`); the NEW need is the
  browser defaulting/refreshing its root to the *currently viewed* session's dir,
  and re-rooting when the user switches sessions.
- **Terminal opens in that directory.** `pty.ts` spawns the shell with a cwd;
  today it's the process/workspace root. Thread the session cwd through: client
  sends the desired cwd on the PTY `create` control message → host validates it
  is within an allowed root (reuse the `roots.ts` fence — never spawn outside it)
  → `node-pty.spawn({ cwd })`. Guard against traversal exactly like the file API.

### 3. Improve file rendering — HTML in particular
- **Current, deliberate state:** `bytes` serves HTML as `application/octet-stream`
  (download, not render) and puts `Content-Security-Policy: default-src 'none';
  …; sandbox` + `nosniff` on served bytes. This was a fix for a **real stored-XSS
  vuln** (pitfall #14): a workspace SVG/HTML with `<script>` ran on the app's
  origin. **Do not regress this.**
- **Safe way to render HTML:** show it in a sandboxed `<iframe>` (a NEW preview
  kind in `preview-kind.ts` + `FilePreview.tsx`). The iframe must be
  `sandbox`-ed (no `allow-same-origin` together with `allow-scripts`, or you
  reopen the hole) and/or load the bytes route (which already sends CSP+sandbox).
  Decide: render as inert HTML (structure/styles, scripts blocked) vs. a
  deliberately-opt-in "run scripts in an isolated origin" mode. Default to inert.
  Add tests mirroring the SVG-XSS ones (see `tests/api.spec.ts` "script the app
  origin"). Other renderers worth extending: notebooks, CSV/TSV tables, more
  image types — but HTML is the ask.

## Hard constraints (do not relearn the hard way)
- **Plugin can't gate the whole app** (why auth is a proxy, not a plugin):
  webServer has only named routes + one fallback (core app owns it), no
  middleware. Irrelevant to this task but explains auth-gateway's shape.
- **Client bundle contract** is replicated in `scripts/tsdown-preset.ts` (CJS in
  `window.__ModuleLoader__.load`, exactly 10 externals, CSS inlined). Don't add a
  new external.
- **Only `--dsw-alias-*` tokens**, stable data attributes, no hash class names.
- **Security:** read-root fence (`roots.ts`), writes off by default, same-origin
  gate on PTY + mutating routes (`origin.ts`), refuse symlink writes, CSP+sandbox
  on served bytes. New surfaces (session-cwd spawn, HTML render) must uphold all.

## Build / test / deploy loop
```sh
cd ~/dsh/plugins
pnpm run check                    # typecheck + 318 tests + build
pnpm --filter dsh-plugin-workbench run build   # after a client change
launchctl kickstart -k gui/$(id -u)/com.tokencv.dsh-web   # reload dsh (link: install picks up the rebuild)
# verify: open https://mac.tokencv.com (logged in), or:
curl -s http://127.0.0.1:3080/plugins/workbench/api/health
```
The `web` profile installs the plugins via `link:` → a rebuild is picked up on dsh
restart. Add tests for every new behavior; mutation-test the security-relevant
ones (revert the guard, confirm the test fails), as the existing suite does.

## Definition of done
Docked right-side panel with a full-frame toggle; file tree + terminal both
default to the active session's directory and follow session switches; HTML files
render safely (sandboxed, XSS tests green); `pnpm run check` green; verified live
in the browser; README + PLAN pitfall list updated; committed and pushed (CI green).
