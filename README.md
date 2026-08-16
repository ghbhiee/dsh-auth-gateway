# dsh-plugins

[![CI](https://github.com/ghbhiee/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/ghbhiee/dsh-plugins/actions/workflows/ci.yml)

Out-of-tree plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

| Package | What it adds |
|---|---|
| [`dsh-plugin-workbench`](packages/workbench) | A file browser, file preview, an editor, and a browser terminal, all on one full-frame surface |
| [`dsh-plugin-mobile-shell`](packages/mobile-shell) | Narrow-viewport drawer, swipe gestures, and a deployment-labelled tab title |
| [`dsh-plugin-cli-session`](packages/cli-session) | A resume-capable CLI runner that prints conversational text or a machine-readable envelope |
| [`dsh-auth-gateway`](packages/auth-gateway) | A passkey (WebAuthn) reverse proxy that guards a dsh web app — a companion process, not a plugin (see its README for why) |

## Install

These are not on the npm registry, so `dsh plugin add <bare-name>` will not find
them. Install from a [release](https://github.com/ghbhiee/dsh-plugins/releases)
tarball (no clone, no registry) or from a local clone. Each package is its own
bundle and installs on its own.

**From a release tarball** — download first, then add the local file. (Passing
the URL straight to `dsh plugin add` trips a pnpm integrity check; download it.)

```sh
curl -LO https://github.com/ghbhiee/dsh-plugins/releases/download/v0.1.0/dsh-plugin-workbench-0.1.0.tgz
dsh plugin --profile web add ./dsh-plugin-workbench-0.1.0.tgz
```

**From a clone** — for local development:

```sh
dsh plugin --profile web add ./packages/workbench
```

Then enable what you want in the profile's `cordis.patch.yml` (each package's
README lists its config). See each package for `--profile` (workbench and
mobile-shell go in a `web`-style profile; cli-session in a headless one).

## Develop

```sh
pnpm install
pnpm run check       # typecheck → test → build, in that order
```

Or individually: `pnpm run typecheck`, `pnpm test` (add `:watch`), `pnpm run build`.

A browser-half change needs a rebuild before `dsh web` picks it up — the shell serves `lib/client.js`, not sources.

## Why the build is not just `tsc`

dsh loads a plugin's browser half through its own frozen module table, and the physical contract for that file — CJS wrapped in `window.__ModuleLoader__.load`, exactly ten external modules, CSS compiled and injected at runtime — lives in the harness repo's `packages/client/tsdown.client.ts`, which is not published. [`scripts/tsdown-preset.ts`](scripts/tsdown-preset.ts) reproduces it so an out-of-tree package can ship UI at all. If a future dsh release changes that contract, this is the one file to update.
