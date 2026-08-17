# dsh-plugin-workbench

A file browser, file preview, and browser terminal for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web UI, as an out-of-tree plugin.

## Install

Not on npm yet. Install from a [release](https://github.com/ghbhiee/dsh-plugins/releases)
tarball (download it first — passing the URL to `dsh plugin add` trips a pnpm
integrity check) or from a local clone:

```sh
# From a release tarball
curl -LO https://github.com/ghbhiee/dsh-plugins/releases/download/v0.1.0/dsh-plugin-workbench-0.1.0.tgz
dsh plugin --profile web add ./dsh-plugin-workbench-0.1.0.tgz

# ...or from a clone
dsh plugin --profile web add ./packages/workbench

dsh web
```

There are two launchers — one at the bottom of the sidebar, and one in the **top-right of the conversation header** (in an active session), so the panel is reachable from the session itself. The surface opens **docked to the right of the active session** by default — chat and files/terminal side by side — with a **Full frame ↔ Dock right** toggle in its header and a draggable divider to resize the split (arrow keys work on it too, and the width persists).

Full-frame, it is a labelled `dialog` that takes focus when it opens; docked, it is a `complementary` region beside a still-usable conversation, so it does not grab focus away. Escape closes it in either mode — except over the terminal, where Escape belongs to the shell (vim, less, readline all want it).

## Configure

Everything that mutates or spawns is off by default. Override in the profile's `cordis.patch.yml`:

```yaml
- id: workbench
  config:
    ptyEnabled: true
    readRoots:
      - /Users/me/notes
```

| Field | Default | Meaning |
|---|---|---|
| `readRoots` | `[]` | Extra absolute directories the browser may read, beyond the session workspace root. Checked at load: a relative path or a missing directory fails the plugin with both problems named, rather than becoming a broken entry in the picker |
| `writeEnabled` | `false` | Allow write/upload/mkdir/rename/delete, and show the editing UI |
| `ptyEnabled` | `false` | Allow the browser to spawn shells |
| `loopbackOnly` | `true` | Refuse callers that did not arrive over loopback |
| `maxListEntries` | `1000` | Cap on entries per directory listing |
| `shell` | `''` | Shell to spawn; empty detects `$SHELL` → zsh → bash (PowerShell on Windows) |

## Surface

| Route | Purpose |
|---|---|
| `GET /plugins/workbench/api/roots` | Readable roots |
| `GET /plugins/workbench/api/list?root=&path=` | Directory listing with type, size, mtime, and what a symlink resolves to |
| `GET /plugins/workbench/api/search?root=&path=&q=` | Filename search under a directory, bounded by results/entries/time |
| `GET /plugins/workbench/api/stat?root=&path=` | Type, size and version — cheap enough to poll while a preview is open |
| `GET /plugins/workbench/api/read?root=&path=` | Text contents plus a freshness `version` (2 MiB cap, refuses binary and non-UTF-8) |
| `GET /plugins/workbench/api/bytes?root=&path=` | Raw bytes with a MIME type, for images |
| `PUT /plugins/workbench/api/write?root=&path=[&version=]` | Body is the new text; with `version` the write is conditional, and the reply carries the new version |
| `POST /plugins/workbench/api/upload?root=&path=` | Body is raw bytes — no multipart parser in the loop |
| `POST /plugins/workbench/api/mkdir?root=&path=` | Create a directory (recursive) |
| `POST /plugins/workbench/api/rename?root=&path=&to=` | Move within the same root |
| `DELETE /plugins/workbench/api/delete?root=&path=[&recursive=1]` | Remove; a directory needs `recursive=1` |
| `WS /plugins/workbench/pty` | Terminal gateway |

**Saving keeps you in step.** The write reply carries the file's new version, so the editor can go on editing and the freshness poll has something to compare against — without it, every save was followed by a needless re-read of the whole file.

**A save cannot clobber someone else's.** `read` hands back the fs seam's freshness token and the editor sends it back on save, so a write whose basis moved on is refused with `409 stale_version` and the draft stays in the textarea rather than being lost or overwriting the other change. Uploads and unconditional writes still work as before.

**Nothing is replaced silently.** POSIX `rename()` overwrites its destination without a word, so renaming onto an existing name destroyed it and answered `{ok:true}`; that now needs an explicit `overwrite=1` and otherwise fails with `409 destination_exists`. Writes and uploads legitimately replace, so they report `overwrote` and the browser names what it replaced.

**A root is never a target.** An empty `path` resolves to the root itself, which made `DELETE ?path=&recursive=1` answer `{ok:true}` after removing the entire workspace. Create, rename, and delete now refuse a root outright; listing one is still fine.

Every mutating route is refused outright unless `writeEnabled` is on, and then has to clear, in order: the sandbox mode (`read-only` refuses everything), a protected-name and protected-segment list (`.env`, `auth.json`, `id_rsa`, `.git/`, `.ssh/`, `node_modules/`, …), the read-root containment fence, and the sandbox policy's writable roots (workspace root, `/tmp`, the OS temp dir) unless the mode is `danger-full-access`. Rename checks the destination as well as the source. Bodies over 32 MiB are rejected while streaming, before anything is written.

Terminal protocol — a bare string is keystrokes in, terminal output back; JSON is control:

- client → server: `{type:'create'[,cwd]}`, `{type:'switch',sessionId}`, `{type:'close',sessionId}`, `{type:'resize',cols,rows}`
- server → client: `{type:'created',id,pid,shell}`, `{type:'switched',id}`, `{type:'exited',id,exitCode}`, `{type:'error',message}`

The first shell's directory rides on the handshake URL (`…/pty?cwd=<dir>`); a later tab carries its `cwd` on `create`. Either way the host fences the directory (below) before spawning, so an unusable value falls back to the workspace root rather than being obeyed.

## Design notes

**A write target may not be a symlink.** The root fence realpaths its target, which catches a symlink pointing outside the root — unless the target does not exist yet, in which case there is nothing to realpath and it anchors on the parent instead. A *dangling* symlink as the last path component has an in-root parent, so it passed, and then a following write (`upload` uses raw `writeFile`) landed wherever the link pointed — outside the root, outside every writable sandbox root. Confirmed before the fix: an upload through a planted symlink wrote a file into `$HOME`. Write, upload and mkdir now `lstat` the target and refuse a symlink outright (`403 symlink_target`); a symlink anywhere but the last component was already caught, because realpath of the parent follows it. Rename and delete still operate on the link itself, which is the point of them.

**Text means UTF-8, and it is checked.** Decoding never throws — invalid bytes become U+FFFD — so a GBK-encoded Chinese file would otherwise be served as mojibake that looks like the file's real contents. The read route round-trips the decode and answers `415 not_utf8` instead, which the preview explains in words.

**Filename search normalizes Unicode.** macOS stores names decomposed (NFD) while people type the composed form, so `café` would miss a file literally called café; both sides are normalized to NFC before matching.

**Workspace bytes cannot script the app.** A workspace is full of files nobody on this side wrote — a cloned repo, a package's assets, whatever an agent just generated — and `bytes` hands them back on the app's own origin. An SVG is a document, not merely a picture: navigating to one containing `<script>` used to run it as the app, with reach into its storage and back into this API, the PTY route included (confirmed in a browser before it was fixed). The route now sends `Content-Security-Policy: default-src 'none'; …; sandbox` and `X-Content-Type-Options: nosniff`, so the script is refused outright and the document lands in an opaque origin either way. The in-app preview is unaffected — it embeds these through `<img>`, which never ran scripts. HTML is not in the MIME allowlist at all, so a workspace `.html` downloads rather than renders.

**HTML previews in a sandboxed frame, inert by default.** `bytes` keeps refusing to serve HTML as a document; the preview renders it a different way, and the `<iframe sandbox>` is the whole trust boundary. The file's text goes into `srcdoc`, so the frame always has an opaque origin, and inert is the default: `sandbox=""` grants nothing, so no script in the page runs at all — you see structure and inline styles. A per-file **Enable scripts** opt-in switches to `sandbox="allow-scripts"`, and never `allow-same-origin` alongside it — that pair is exactly what would let the framed page reach back into the app, reopening the hole above. Even with scripts on, the opaque origin means the page cannot touch the app's DOM, cookies, or storage, cannot navigate the top frame, and cannot read the workbench API (no CORS on it); confirmed in a browser, a page that tried to set the app's title and write its `localStorage` did neither, while its own body script ran. Toggling the opt-in remounts the frame, because changing `sandbox` on a live `srcdoc` frame does not re-load it. **View source** drops back to the read block, and Edit still edits the raw markup.

**Rooted at the session's directory.** The file tree opens in the directory of the session you are viewing, and re-roots when you switch sessions; the terminal spawns its shell there too. The directory comes from the client's own session store (`useSessions` — nothing new is fetched) and is mapped onto whichever readable root contains it, so the browser only ever asks the host for a root+path the fence already allows. The cwd the client asks the *terminal* for is as untrusted as any path: `resolveCwdWithinRoots` requires it to be absolute and to `realpath` inside an allowed root (canonicalized, so a symlinked cwd is followed before it reaches `node-pty`), and anything else falls back to the workspace root. A session whose directory the fence does not cover simply opens at the workspace root instead of failing.

**The header launcher drives the surface through an event bridge.** The surface and the sidebar launcher are root-scoped and share one `workbenchStore`; the conversation-header launcher is *session*-scoped, and a store handle may mount at only one scope ("one handle, one scope"), so a session seat cannot bind the root store. It dispatches a window event (`dsh-workbench:toggle`) instead, and the always-mounted overlay — it renders `null` while closed but stays mounted — listens and calls the store action. The same bridge carries an `open-file` request (a preview target), which is wired end to end and tested but currently has no seat dispatching it: dsh's own produced-files signal is not loaded in every profile and, by design, only tracks structured file-edit tools (not files a `bash` step writes), so an artifact-link surface was left out rather than shipped half-covering.

**Docked without patching the layout.** The right-hand dock reserves a strip on the frame rather than floating over the chat. The overlay component marks the AppFrame (`data-workbench-docked`) and publishes the width as a `--wb-dock-width` custom property; a global stylesheet — keyed on that attribute and the layout's own structural contract, the conversation being the frame's **second grid child**, never a compiled CSS-Module hash class (those change every upstream build) — pushes the conversation column in by that width and pins the panel to the freed strip. The sidebar's own width is left alone, so it is a true split, not an overlay. Full-frame mode sets none of it, and the panel keeps its `inset: 0` and covers the frame as before. Same anchor and same discipline mobile-shell uses for its drawer.

**A truncated listing still shows the directories.** The cap applies after sorting, not to the raw stream from the filesystem. Cutting the stream instead would return whichever names the filesystem happened to yield first — arbitrary, and sorted afterwards so it merely looked ordered — which in a directory past the cap could drop every subdirectory, and a folder you cannot see is one you cannot open. Names and kinds are collected first (no syscall each), then sorted and cut; only the survivors are stat'd, so the expensive pass stays capped either way. A 20 000-entry directory lists in under 50 ms.

**A symlink reports as a symlink, plus what it points at.** The browser needs the target's kind to know whether clicking should navigate or preview, and the read routes `stat` rather than `lstat` so a link to a directory is refused as a directory — otherwise the check passes, the fs seam throws, and the user gets a 500 that explains nothing. Links pointing outside a root still fail the fence.

**Search is a bounded walk, not ripgrep.** The harness vendors rg inside `tool-fs-search`, but that is an internal dependency resolved from its own tree, and matching filenames does not need it. The walk is breadth-first so a truncated search still returns the shallow matches a person meant, skips `.git` / `node_modules` and friends, never descends a symlinked directory (cycle guard and fence in one), and stops at 200 hits, 20 000 entries, or two seconds — whichever comes first, saying so when it does.

**Reads need their own fence.** The harness's `fs-sandbox` guards writes only — reads pass straight through to the local filesystem. Every path here is resolved twice: a lexical traversal reject, then a `realpath` containment check, so a symlink inside a root cannot point out of it.

**A loopback check is not an origin check, and the terminal is a shell.** A WebSocket handshake and a cross-site `fetch` are not stopped by the same-origin policy, and both come from the user's own browser — so `loopbackOnly` sees loopback and waves them through. A page the user merely visits could therefore open the PTY and run commands (`ws://127.0.0.1:…/plugins/workbench/pty`), or, with writes on, POST a file into the workspace. This was confirmed end to end: a page on a different port reached `created` and executed `id`. Both the upgrade and the mutating HTTP verbs now check `Origin` — a browser always sends it, a same-origin one matches `Host`, and a request without one is not a browser and passes. Cross-origin handshakes are refused before a shell is spawned; cross-origin writes answer `403 cross_origin`.

**The terminal does not use `ctx.terminals`.** That registry is the agent-facing PTY surface: `TERM=dumb`, every CSI/OSC sequence stripped on the way out, a rewritten prompt, one in-flight send per session, and an owning `Agent` required on every call. All four are right for a model and wrong for xterm.js. This plugin sits one layer down, on raw PTY bytes.

**node-pty's spawn-helper gets its execute bit back.** A store-based install (pnpm) can leave `spawn-helper` at 0644, after which every spawn fails with a bare `posix_spawnp failed.` that names nothing. The gateway checks and chmods it before the first spawn.

**node-pty is borrowed, not vendored.** dsh already installs it; the gateway resolves it from this module first and then from `ctx.baseUrl` (the profile directory), because a `link:`-installed plugin does not see the profile's hoisted tree from its own `node_modules`.

**The pane's rules live outside the pane.** Frame classification, the backoff, and the tab/active-session transitions are pure functions in `src/client/terminal-model.ts`; the component keeps the socket, the xterm instances, and the timers. That is what makes the reconnect behaviour testable without pushing xterm through jsdom.

**Teardown hangs up.** `WebSocketServer.close()` leaves established sockets open, so a plugin unload would kill the shells while the browser kept a socket to a gateway that no longer existed — no close event, therefore no reconnect, and a terminal frozen for good. Disposal closes each socket with 1001 before shutting the server down.

**The terminal reconnects, and says so.** A dropped socket means the server-side PTYs died with it, so the pane clears its tabs rather than leaving dead ones on screen, shows a status line with a manual retry, and reconnects on a 1/2/4/8/15s backoff — the shell comes back by itself after a `dsh` restart or a laptop sleep.

**URLs in terminal output are clickable** through xterm's web-links addon — tools print them constantly and selecting one by hand is a chore.

**Previews reuse the harness primitives** — `ReadBlock` (line numbers + shiki), `MarkdownText` (GFM + KaTeX), and the theme's `--dsw-alias-*` tokens — rather than bringing a second markdown or highlighting stack.

## Editing

With `writeEnabled` on, the browser half grows an action bar (new file, new folder, upload), accepts files dragged onto the list (dropped into whichever directory is open, not the root), and, once an entry is marked by clicking its icon, rename and delete. Deletion is a two-step arm-then-confirm on the same button rather than a dialog. A text preview gains an Edit button, a plain textarea, and Save (Cmd/Ctrl+S), after which the listing refreshes. With writes off, none of it renders — the browser asks `/health` for that flag, and the host enforces it regardless.

## Tests

`pnpm test` runs the host surface against a real socket and a real temp directory (routing, both fences, every status code), the terminal gateway against a real WebSocket and a real shell (the control protocol, resize reaching the pty, shells dying with their socket), and the browser half in jsdom (the action bar's inline naming and arm-then-confirm delete, listing and navigation, and the capability gate). No API key or running `dsh` required.

**Misconfiguration fails at load, not at click time.** `readRoots` is validated when the plugin mounts — every bad entry is named at once — because the alternative is a root that sits in the picker and answers each request with a puzzling 404, and because the harness's own rule is that a missing referent is never silently skipped.

**The preview lays out a window, not the whole file.** The primitive's own default is 16 lines — right for a tool-result card, useless for reading — and the other extreme is worse: all 30 000 lines of a long file is 90 000 DOM nodes and 46–154 ms of reflow on every later re-render, against 6 000 nodes and 6–11 ms for a 2 000-line window. The header says how much of the file you are seeing, and the terminal is one tab away for the rest.

**An open preview keeps up too, without eating your draft.** The pane polls the cheap `stat` route and only re-reads when the version moved. If you are editing, it never touches the textarea — it says the file changed on disk and lets the conditional save be the thing that refuses to clobber.

**A late poll cannot undo what you just did.** Every mutation bumps a generation counter, and a poll whose request left before it discards its own answer — otherwise the listing that was fetched a moment before a delete lands afterwards and puts the deleted file back on screen for a few seconds.

**The listing keeps up with the agent.** Files appear while you are looking at the directory they land in, so the pane re-checks on an interval and on focus rather than making you navigate away and back. Nothing happens while the tab is hidden — browsers throttle background timers anyway, and the focus handler catches up the moment you return.

**A switched-off feature says so.** `health` reports both `writeEnabled` and `ptyEnabled`; with terminals off the pane says the deployment has them disabled and never opens a socket, instead of retrying an upgrade route that does not exist and calling it a dropped connection.

**Errors are re-worded for whoever is looking.** The API's messages are written for a request log — English, naming query parameters, describing the rule rather than the way out — so the browser translates the stable error *codes* into its own localized sentences and keeps the host's text only for codes it has not learned. Nobody should be told to "pass overwrite=1" by a file browser.

## What the tests pin down that is easy to break later

- Recursive delete **unlinks** a symlink rather than descending it, so removing a folder that contains a shortcut cannot take the shortcut's target with it.
- An interrupted upload leaves the existing file untouched — the body is buffered before anything is written, and streaming straight to disk would quietly break that.
- A filename containing CRLF cannot inject a response header.

## Known limitations

- **Long files are windowed.** The preview lays out the first 2 000 lines and says so; markdown over that length falls back to the source view, because the markdown renderer has no windowing of its own.
- **The editor is a textarea.** No syntax highlighting while editing, no autosave, no conflict detection: a save overwrites whatever is on disk.
- **mkdir/rename/delete bypass the fs seam.** `ctx.fs` has no equivalent (it exposes read, write, and edit only), so those three go through `node:fs` and this plugin's own guard is the only gate — unlike `write`, which additionally passes the harness's per-call write policy.
- **A session keeps the sandbox mode it was spawned under.** Lowering the mode later does not retroactively confine a running shell — close it and open a new one.
- **No remote runtimes.** Spawning goes straight to node-pty instead of `ctx.subprocess.spawnTerminal`, because that seam's handle exposes no `resize()` (rows/cols are fixed at spawn). Terminals therefore only work where the host process runs.
- **Reconnecting does not restore the old shells.** They are gone with the socket; you get a fresh one, and scrollback from before the drop is lost.
- **Refreshing is polling, not watching.** The listing and any open preview re-check every five seconds while visible, and immediately when the tab regains focus; there is no filesystem watch, so a change can take up to five seconds to show. Searching pauses the listing poll.
- **HTML previews are sandboxed and, by default, inert.** Scripts are blocked unless you opt in per file, and even then run walled off in an opaque origin. Because the frame has no base URL and no same-origin access, a page's relative or external resources — its own linked CSS/JS/images — may not load: it is a structure-and-inline-styles preview, not a live site. Use **View source** for the markup.
- **No Range requests.** `bytes` sends whole files, so large media cannot be seeked; it is meant for images and small downloads.
- **Only UTF-8 text is displayable.** Other encodings are detected and refused rather than transcoded; there is no encoding picker.
