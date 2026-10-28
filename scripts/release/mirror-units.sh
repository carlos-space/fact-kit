#!/usr/bin/env bash
# Mirror the Go and Swift units into their own repositories. Neither has a registry: the Go proxy and SwiftPM read
# the tags of a repository whose root is the package, so each release is pushed from packages/<unit>/ to the
# default branch of carlos-space/<component> and tagged there with the bare version.
#
#   Go     v<version>    (0.3.0-alpha.2 -> v0.3.0-alpha.2)    the Go proxy needs the "v"
#   Swift  <version>     (0.3.0-alpha.2 -> 0.3.0-alpha.2)     SwiftPM reads SemVer tags without the "v"
#
# The mirror history is `git subtree split --prefix=<unit path>` of the unit's release tag
# (<component>/v<version>, see unit_tag). The split is deterministic: the same source commits give the same mirror
# commits, and a later release descends from an earlier one on the release branch, so every release is a
# fast-forward of main and a rerun computes the commit it pushed the first time. The script never forces a push.
#
# A rerun is safe:
#   - the mirror tag exists and points at the split commit: nothing to do
#   - the mirror tag exists and points elsewhere: refuse, because a published version must not move
#   - the split commit is already part of main (an older version dispatched again): only the tag is pushed
#   - main is not an ancestor of the split commit: refuse (someone pushed to the mirror, or history was rewritten)
#
# usage: mirror-units.sh [--dry-run] <path>...      units that are not Go or Swift are skipped
#   --dry-run         split and print what would be pushed (commit, tag, file list); nothing is written. Without a
#                     release tag the split runs on HEAD, so the unit can be rehearsed on a branch.
#   MIRROR_OWNER      owner of the mirror repositories (default carlos-space); the repository is the component name
#   MIRROR_REMOTE     full remote URL or path, replaces owner/component (tests use a local bare repository)
#   MIRROR_PUSH_TOKEN GitHub App token with contents: write on the mirror repositories; sent as an HTTP header, never in a URL
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
cd "$REPO_ROOT"

dry=0
if [[ "${1:-}" == --dry-run ]]; then dry=1; shift; fi
[[ $# -ge 1 ]] || die "usage: mirror-units.sh [--dry-run] <path>..."

# mirror_tag <registry> <version> → the tag in the mirror repository
mirror_tag() {
  case "$1" in
    go) printf 'v%s\n' "$2" ;;
    swift) printf '%s\n' "$2" ;;
    *) return 1 ;;
  esac
}

# git against the mirror, with the token as a header when there is one
mgit() {
  if [[ -n "${MIRROR_PUSH_TOKEN:-}" ]]; then
    git -c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$MIRROR_PUSH_TOKEN" | base64 | tr -d '\n')" "$@"
  else
    git "$@"
  fi
}

mirror_unit() { # mirror_unit <path>
  local p="${1%/}" reg ver comp remote mtag ref sha tagged main errs
  reg="$(unit_registry "$p" 2>/dev/null || true)"
  if [[ "$reg" != go && "$reg" != swift ]]; then info "$p: not a Go or Swift unit, skipped"; return 0; fi
  jq -e --arg p "$p" '.packages | has($p)' "$CONFIG" >/dev/null || die "unexpected package path: $p (not a key of packages in $CONFIG)"
  ver="$(manifest_version "$p")"
  version_stage "$ver" >/dev/null || die "$p: version \"$ver\" is not X.Y.Z or X.Y.Z-<alpha|beta|rc>.N"
  comp="$(unit_component "$p")"
  remote="${MIRROR_REMOTE:-https://github.com/${MIRROR_OWNER:-carlos-space}/$comp.git}"
  mtag="$(mirror_tag "$reg" "$ver")"

  ref="$(unit_tag "$p" "$ver")"
  if ! git rev-parse -q --verify "refs/tags/$ref^{commit}" >/dev/null 2>&1; then
    (( dry )) || die "release tag $ref does not exist, so $p $ver has not been released"
    info "release tag $ref does not exist yet (dry run): splitting HEAD"
    ref=HEAD
  fi
  # subtree split writes a progress counter to stderr; keep it out of the log unless the split fails
  errs="$(mktemp)"
  sha="$(git subtree split --prefix="$p" "$ref" 2>"$errs")" || { tr '\r' '\n' < "$errs" >&2; rm -f "$errs"; die "$p: git subtree split failed"; }
  rm -f "$errs"
  [[ -n "$sha" ]] || die "$p: git subtree split produced no commit (is $p part of $ref?)"
  case "$reg" in
    go) git cat-file -e "$sha:go.mod" 2>/dev/null || die "$p: the split root has no go.mod" ;;
    swift) git cat-file -e "$sha:Package.swift" 2>/dev/null || die "$p: the split root has no Package.swift" ;;
  esac

  # what the mirror has now (a read; works without a token on a public repository)
  tagged="$(mgit ls-remote "$remote" "refs/tags/$mtag" | cut -f1)"
  main="$(mgit ls-remote "$remote" refs/heads/main | cut -f1)"
  local action=push
  if [[ -n "$tagged" ]]; then
    [[ "$tagged" == "$sha" ]] || die "$comp already has tag $mtag at ${tagged:0:12}, but $ref splits to ${sha:0:12}; a published version must not move"
    action=none
  elif [[ -n "$main" ]]; then
    mgit fetch -q --no-tags "$remote" refs/heads/main
    if git merge-base --is-ancestor "$sha" "$main" 2>/dev/null; then action=tag-only
    elif ! git merge-base --is-ancestor "$main" "$sha" 2>/dev/null; then
      die "$comp main (${main:0:12}) is not an ancestor of $ref's split (${sha:0:12}); pushing would not be a fast-forward"
    fi
  fi

  local report
  report="$({
    echo "## $comp  ($p $ver)"
    echo "source        $ref"
    echo "mirror        $remote"
    echo "split commit  $sha"
    echo "mirror tag    $mtag"
    echo "remote main   ${main:-(empty)}"
    echo "action        $action"
    echo "history (newest first, up to 5):"
    git log --format='  %h %s' -n 5 "$sha"
    echo "files at the mirror root ($(git ls-tree -r --name-only "$sha" | wc -l | tr -d ' ')):"
    git ls-tree -r --name-only "$sha" | sed 's/^/  /'
    [[ "$reg" != go ]] || echo "go.mod: $(git show "$sha:go.mod" | sed -n '/^module /p')"
  })"
  printf '%s\n' "$report"
  [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf '\n```\n%s\n```\n' "$report" >> "$GITHUB_STEP_SUMMARY"

  if (( dry )); then echo "dry run: nothing pushed"; return 0; fi
  case "$action" in
    none) echo "$comp $mtag is already mirrored, nothing to push" ;;
    tag-only) mgit push "$remote" "$sha:refs/tags/$mtag" ;;
    push) mgit push --atomic "$remote" "$sha:refs/heads/main" "$sha:refs/tags/$mtag" ;;
  esac
}

for p in "$@"; do mirror_unit "$p"; done
