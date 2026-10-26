#!/usr/bin/env bash
# Publish packages to the public npm registry. publish.yml calls it with the package paths a release created.
# usage: publish-units.sh <alpha|beta|rc|ga> <package path>...      e.g. alpha js
#   <stage>          the release stage of the train, and so the npm dist-tag: alpha, beta and rc publish under
#                    the tag of that name, ga under latest. `latest` must only ever point at a GA, so every
#                    package version must belong to the stage (X.Y.Z-<stage>.N, or X.Y.Z for ga); a mismatch
#                    stops the run before anything is packed.
#   PUBLISH_OUT          where tarballs are packed (default tmp/publish)
#   PUBLISH_DRY_RUN      1 passes --dry-run to npm publish
#   PUBLISH_CHECK_ONLY   1 stops after the checks (file version, stage, same content as the tag), before the
#                        registry lookup, packing and upload. Used by publish-units.test.ts.
#
# Every package publishes to registry.npmjs.org through npm Trusted Publishing (OIDC, npm >= 11.5.1), so
# no token is read. A package whose publishConfig.registry names another registry is refused. pnpm packs
# and the npm CLI publishes the tarball. The tarball is scanned before it is published. A version already
# in the registry is skipped, so a re-run is safe. package.json must carry the version in .release-please-manifest.json.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
die() { echo "::error::$*" >&2; exit 1; }
summary() { [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf '%s\n' "- $*" >> "$GITHUB_STEP_SUMMARY"; }

# version_stage <version> → the stage a package version belongs to: ga for X.Y.Z, <stage> for
# X.Y.Z-<stage>.N with <stage> one of alpha, beta, rc. Any other shape fails, because the dist-tag is
# derived from the stage and must not be guessed.
version_stage() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[2]:-ga}"
}

npm_dist_tag() { if [[ "$1" == ga ]]; then printf '%s\n' latest; else printf '%s\n' "$1"; fi; }

# A publish that failed after its tag was made can be dispatched again from the release branch once the fix
# lands there. That is only safe while the package's own files still equal the tag: otherwise one version
# number would name two different packages. publish.yml's checkout is shallow and carries no tags, so a
# shallow clone fetches the tag first; a package without a tag has nothing to compare.
check_same_as_tag() { # check_same_as_tag <package path> <version>
  local comp t
  comp="$(jq -r --arg p "$1" '.packages[$p].component // empty' release-please-config.json 2>/dev/null || true)"
  t="${comp:-$(basename "$1")}/v$2"
  if ! git rev-parse -q --verify "refs/tags/$t" >/dev/null 2>&1; then
    [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == true ]] || return 0
    git fetch -q --depth=1 origin "refs/tags/$t:refs/tags/$t" 2>/dev/null || return 0
  fi
  git diff --quiet "$t" HEAD -- "$1" \
    || die "$1 的內容和 tag $t 不同。修正動到套件本身時，要推進到下一個序號重發，不能用同一個版號"
}

publish_one() { # publish_one <package path> <stage>
  local p="$1" stage="$2" name ver want reg tgz out vs
  local -a dry=()
  [[ -f "$p/package.json" ]] || die "$p/package.json not found"
  name="$(jq -r .name "$p/package.json")"
  ver="$(jq -r .version "$p/package.json")"
  want="$(jq -r --arg p "$p" '.[$p] // empty' .release-please-manifest.json)"
  [[ -n "$want" ]] || die "$p is not in .release-please-manifest.json"
  [[ "$ver" == "$want" ]] || die "$p: manifest says $want but package.json says $ver"
  vs="$(version_stage "$ver")" || die "$p: version $ver is not X.Y.Z or X.Y.Z-<alpha|beta|rc>.N, so its release stage is unknown"
  [[ "$vs" == "$stage" ]] || die "$p: version $ver belongs to stage $vs, but this release's stage is $stage"
  check_same_as_tag "$p" "$ver"
  reg="$(jq -r '.publishConfig.registry // "https://registry.npmjs.org"' "$p/package.json")"

  [[ "$reg" == "https://registry.npmjs.org" ]] || die "$p: publishConfig.registry is $reg, only https://registry.npmjs.org is supported"

  if [[ "${PUBLISH_CHECK_ONLY:-0}" == 1 ]]; then
    echo "check only: $name@$ver passed (stage $stage, dist-tag $(npm_dist_tag "$stage")); nothing packed or published"; return 0
  fi

  if npm view "$name@$ver" version --registry "$reg" 2>/dev/null | grep -qx "$ver"; then
    echo "$name@$ver is already on $reg, skipping"; summary "\`$name@$ver\` already on $reg, skipped"; return 0
  fi

  out="$PUBLISH_OUT/$(basename "$p")"
  rm -rf "$out"; mkdir -p "$out/unpacked"
  (cd "$p" && pnpm pack --pack-destination "$out" >/dev/null)
  tgz="$(find "$out" -maxdepth 1 -name '*.tgz' | head -1)"
  [[ -n "$tgz" ]] || die "no tarball after packing $p"
  tar -xzf "$tgz" -C "$out/unpacked"
  bash scripts/release/scan-tarball.sh "$out/unpacked" "$p" || die "$name tarball failed the content scan; nothing was published"

  [[ "${PUBLISH_DRY_RUN:-0}" == 1 ]] && dry=(--dry-run)
  echo "publishing $name@$ver to $reg with dist-tag $(npm_dist_tag "$stage") ${dry[*]:-}"
  npm publish "$tgz" --access public --tag "$(npm_dist_tag "$stage")" --registry "$reg" ${dry[@]+"${dry[@]}"}
  summary "published \`$name@$ver\` to $reg, dist-tag \`$(npm_dist_tag "$stage")\` ${dry[*]:-}"
}

usage="usage: publish-units.sh <alpha|beta|rc|ga> <package path>..."
[[ $# -ge 2 ]] || die "$usage"
stage="$1"
case "$stage" in alpha | beta | rc | ga) ;; *) die "stage \"${stage}\" is not alpha, beta, rc or ga. $usage" ;; esac
shift
PUBLISH_OUT="${PUBLISH_OUT:-$root/tmp/publish}"
for u in "$@"; do
  u="${u%/}"
  jq -e --arg p "$u" '.packages | has($p)' release-please-config.json >/dev/null 2>&1 \
    || die "unexpected package path: $u (not a key of packages in release-please-config.json)"
  publish_one "$u" "$stage"
done
