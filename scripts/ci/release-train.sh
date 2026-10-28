#!/usr/bin/env bash
# The version the open Release PR of a release branch is about to release, as a line for $GITHUB_ENV:
#   FACT_KIT_TRAIN=--train <describes name>=<version>
# The facts are pinned to that version on the release branch before the Release PR merges, while describes
# still reads the old version from packages/fact-kit-js/package.json. `check --train` lets since be as new as the train, and it
# fails a row that is still `next`. Prints nothing when the branch has no open Release PR, or when the unit is
# in release-policy.json but not on this branch's train.
#
# The version is the one release-please wrote into .release-please-manifest.json on the Release PR branch.
# That file is what release-please releases from, so it is the version the tag will carry. The unit is found
# from release-please-config.json by its component, as the release scripts do.
#
# usage: release-train.sh [component [describes name]]     (default: fact-kit-js fact-kit)
#   component       the release-please component of the unit, which is its directory name
#   describes name  the key of `describes` in the facts of that unit, which `check --train` matches. It is the
#                   package name fact-kit for fact-kit-js, and equals the component when not given.
#   env: BRANCH  the release branch, e.g. release/v0.8
#        REPO    owner/name
#        GH_TOKEN  a token with contents: read and pull-requests: read
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ $# -eq 0 ]]; then component=fact-kit-js describes=fact-kit; else component="$1" describes="${2:-$1}"; fi
branch="${BRANCH:?BRANCH is not set}"
repo="${REPO:?REPO is not set}"

path="$(jq -r --arg c "$component" '.packages | to_entries[] | select((.value.component // (.key | split("/") | last)) == $c) | .key' release-please-config.json | head -1)"
if [[ -z "$path" ]]; then
  # A release branch's config lists only its train. A unit of release-policy.json that is not on this train
  # releases nothing here, so there is no version to check since against.
  if jq -e --arg c "$component" '.units | has($c)' release-policy.json >/dev/null 2>&1; then
    echo "release-train: $component is not on the train of $branch, so no --train" >&2
    exit 0
  fi
  echo "release-train: no unit of component $component in release-please-config.json" >&2
  exit 1
fi

head="$(gh pr list --repo "$repo" --base "$branch" --state open --json headRefName \
  --jq '[.[] | select(.headRefName | startswith("release-please--"))][0].headRefName // empty')"
if [[ -z "$head" ]]; then
  echo "release-train: no open Release PR on $branch, so no --train" >&2
  exit 0
fi

ref="$(jq -rn --arg r "$head" '$r | @uri')"
version="$(gh api "repos/$repo/contents/.release-please-manifest.json?ref=$ref" --jq .content | base64 --decode | jq -r --arg p "$path" '.[$p] // empty')"
[[ -n "$version" ]] || { echo "release-train: $head has no version for $path in .release-please-manifest.json" >&2; exit 1; }

echo "release-train: $component $version from the Release PR branch $head" >&2
printf 'FACT_KIT_TRAIN=--train %s=%s\n' "$describes" "$version"
