#!/bin/sh
# Builds, or removes, the throwaway repository the capture sessions run in.
#
#   demo-repo.sh create          prints the new repository's path
#   demo-repo.sh clean <path>    removes it, and the transcripts Claude Code kept for it
#
# Why it exists: the capture steps accept Claude Code's "trust this folder" dialog and a model session then runs in the
# folder, so the folder must hold nothing but what you mean to show. `create` therefore builds it from the files git
# TRACKS at HEAD (git archive): untracked files, ignored files (.env, local settings, virtualenvs, keys) and your
# uncommitted edits never get in. It is made in a private (mode 700) mktemp directory and carries a marker that record.py
# and make.py require, so they refuse to run in any other folder, including your real checkout.
set -eu

MARK=nexus-capture-demo          # a file inside the demo repo's .git directory (never part of the tree)
here="$(cd "$(dirname "$0")" && pwd -P)"
# CAPTURE_SOURCE_REPO exists for the self-test; normally the repository this script belongs to.
src="${CAPTURE_SOURCE_REPO:-$(git -C "$here" rev-parse --show-toplevel)}"

die() { echo "demo-repo: $*" >&2; exit 1; }

case "${1:-}" in
create)
  base="$(mktemp -d /tmp/nexus-demo-XXXXXX)"          # unique, mode 700, no dots (the on-screen path stays short)
  chmod 700 "$base"
  dest="$base/nexus"
  mkdir "$dest"
  # The image folders are left out only to keep the copy small; everything else committed at HEAD is included.
  git -C "$src" archive --format=tar HEAD -- . ':(exclude)mod/nexus/docs/media' ':(exclude)mod/nexus/docs/screenshots' | tar -x -C "$dest"
  (
    cd "$dest"
    # --template= : no hook or config templates from the machine; -c ... : no signing, no global hooks.
    git init -q --template= -b main
    git add -A
    git -c user.name=demo -c user.email=demo@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m "demo"
    printf 'built from %s tracked files at %s\n' "$(git -C "$src" ls-files | wc -l | tr -d ' ')" "$(git -C "$src" rev-parse --short HEAD)" > ".git/$MARK"
  )
  printf '%s\n' "$(cd "$dest" && pwd -P)"
  ;;
clean)
  [ $# -eq 2 ] || die "usage: demo-repo.sh clean <path>"
  [ -d "$2" ] || die "not a directory: $2"
  real="$(cd "$2" && pwd -P)"
  [ -f "$real/.git/$MARK" ] || die "refusing: $real has no capture marker, so it was not made by 'create'"
  case "$real" in
    /private/tmp/nexus-demo-??????/nexus | /tmp/nexus-demo-??????/nexus) ;;
    *) die "refusing: $real is not a path 'create' makes" ;;
  esac
  base="$(dirname "$real")"
  # Claude Code keeps session transcripts per working directory, named by the path with every non-alphanumeric as '-'.
  enc="$(printf '%s' "$real" | sed 's/[^A-Za-z0-9]/-/g')"
  t="$HOME/.claude/projects/$enc"
  case "$t" in
    "$HOME"/.claude/projects/-*nexus-demo-*) if [ -d "$t" ]; then rm -rf "$t"; echo "removed transcripts: $t"; fi ;;
  esac
  rm -rf "$base"
  echo "removed $base"
  echo "Not touched: ~/.claude.json. Claude Code recorded a 'trusted folder' entry there for $real; it is harmless, and you can delete it by hand."
  ;;
*)
  die "usage: demo-repo.sh create | clean <path>"
  ;;
esac
