# dsh-plugin-mobile-shell

Narrow-viewport affordances for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web UI: a drawer sidebar with a hamburger and scrim, swipe gestures, and a deployment-labelled browser tab title.

It replaces a set of hand-applied patches to `@deepseek-ai/dsh-client-ui-layout`'s compiled bundle — the kind that has to be re-applied after every `npm i -g` and that breaks silently when the upstream build changes a hashed class name.

## Install

Not on npm yet. Install from a [release](https://github.com/ghbhiee/dsh-plugins/releases)
tarball (download it first — passing the URL to `dsh plugin add` trips a pnpm
integrity check) or from a local clone:

```sh
# From a release tarball
curl -LO https://github.com/ghbhiee/dsh-plugins/releases/download/v0.1.0/dsh-plugin-mobile-shell-0.1.0.tgz
dsh plugin --profile web add ./dsh-plugin-mobile-shell-0.1.0.tgz

# ...or from a clone
dsh plugin --profile web add ./packages/mobile-shell
```

Browser-only: the host half is an empty plugin whose sole job is to make the package visible to the Loader, which is how its `dsh.client` half gets served.

## Configure

```yaml
- id: mobile-shell
  config:
    narrowMaxWidth: 1440        # frame width at or below which the drawer takes over
    documentTitle: 'WB · {host}' # '' leaves the shell's own session title alone
```

A client entry never sees its row's config, so the browser half asks for these over a small host route and falls back to the defaults (1023 / `DSH · {host}`) if it cannot.

## What it does

Below the configured frame width (1023px by default — the threshold the shell itself uses to auto-collapse the sidebar):

- **Drawer sidebar.** The grid collapses to one column and the sidebar floats over the conversation instead of squeezing it, with a hamburger at the top left and a scrim behind it.
- **Direction-aware swipe.** Swipe right to open, left to close. (The patch this replaces toggled on either direction, so a left swipe on a closed drawer opened it.)
- **Tapping a group keeps the drawer open.** An expandable row carries `aria-expanded`; a leaf does not, and picking a leaf closes the drawer as you would expect after navigating.

At any width:

- **The tab title reads `DSH · <hostname>`,** so several deployments are distinguishable in a row of tabs. It is pinned with a `MutationObserver` on `<title>`, so it survives the shell's own session-title projection.

## How it hooks in

Everything is plugin-space:

- The controls are one `shell.overlay` registration — the frame-wide layer that exists for exactly this.
- Behaviour drives `ctx.layout.toggleSidebar()`, the cross-plugin panel face.
- The drawer geometry is a global stylesheet keyed on **stable DOM contract only**: the `[data-shell-overlay]` layer (used to identify the frame via `:has()`) and the frame's `data-sidebar-collapsed` attribute. No compiled CSS-Module hash class is referenced anywhere, and colors come from `--dsw-alias-*` tokens.

Two things worth knowing if you extend this:

- **`data-sidebar-collapsed` is absent when open**, not `"false"` — React drops a false-valued `data-*` prop. Match `:not([data-sidebar-collapsed='true'])`.
- **One threshold, not two.** The drawer's CSS keys on a `data-mobile-shell-narrow` mark the component sets from its measurement, not on a `@media` query — a media query would be a second copy of the threshold that silently diverges the moment it is configured.
- **Narrow-ness is measured from the frame box** with a `ResizeObserver`, not from `matchMedia`. That mirrors how the shell decides, and a media-query listener can miss viewport changes that never fire `change` (devtools emulation, pane resizes), which strands the hamburger on a wide layout.

## Tests

`pnpm test` covers the two contracts that broke during development — the absent-when-open attribute and frame-measured narrowness — plus the drawer controls, leaf-vs-group closing, and swipe direction. Reverting either historical bug turns 7 of the 17 red, so the net demonstrably holds.

## Known limitations

- **The "reclaim vertical padding" tweak was dropped.** The patch it came from targeted compiled CSS-Module class names (`.wSkVaW_header`), of which the current build has five variants — it would fail silently on the next upstream release. The center column instead gets top padding so the hamburger does not cover content.
- **Swipe listens on the whole document,** so a horizontal drag inside a scrollable area can still move the drawer.
