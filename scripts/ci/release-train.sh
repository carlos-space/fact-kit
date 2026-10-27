#!/usr/bin/env bash
# The version the open Release PR of a release branch is about to release, as a line for $GITHUB_ENV:
#   FACT_KIT_TRAIN=--train fact-kit=<version>
# The facts are pinned to that version on the release branch before the Release PR merges, while describes
# still reads the old version from js/package.json. `check --train` lets since be as new as the train, and it
# fails a row that is still `next`. Prints nothing when the branch has no open Release PR.
#
# The version is the one release-please wrote into .release-please-manifest.json on the Release PR branch.
# That file is what release-please releases from, so it is the version the tag will carry. The unit is found
# from release-please-config.json by its component, as the release scripts do.
#
# usage: release-train.sh [component]     (default: fact-kit)
#   env: BRANCH  the release branch, e.g. release/v0.8
#        REPO    owner/name
#        GH_TOKEN  a token with contents: read and pull-requests: read
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
component="${1:-fact-kit}"
branch="${BRANCH:?BRANCH is not set}"
repo="${REPO:?REPO is not set}"

path="$(jq -r --arg c "$component" '.packages | to_entries[] | select((.value.component // (.key | split("/") | last)) == $c) | .key' release-please-config.json | head -1)"
[[ -n "$path" ]] || { echo "release-train: no unit of component $component in release-please-config.json" >&2; exit 1; }

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
printf 'FACT_KIT_TRAIN=--train %s=%s\n' "$component" "$version"
