#!/usr/bin/env bash
# Mirror each package to its standalone install repo (github:ghbhiee/dsh-plugin-<name>).
#
# The monorepo is the development home; the standalone repos exist so a bare
# `dsh plugin --profile <p> add github:ghbhiee/dsh-plugin-<name>` works without
# the #path: fragment. `git subtree split` rewrites each package's history into
# a standalone lineage deterministically, so re-running pushes only the new
# commits. Run from a clean checkout AFTER building and committing lib/ —
# whatever lib/ is committed here is exactly what a git install serves.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

for name in workbench mobile-shell cli-session; do
  branch="split/$name"
  git subtree split --prefix="packages/$name" -b "$branch" >/dev/null
  git push "https://github.com/ghbhiee/dsh-plugin-$name.git" "$branch:main"
  git branch -D "$branch" >/dev/null
  echo "synced dsh-plugin-$name"
done
