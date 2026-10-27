#!/usr/bin/env bash
# Publish the units a release created. publish.yml calls it with the unit paths of the release; every
# stage of a train publishes (alpha, beta and rc as prereleases, ga as the final version).
#
# The registry follows from the file the unit directory carries (unit_registry in scripts/lib/release-stages.sh):
#   package.json    npm        dist-tag is the stage (alpha | beta | rc), latest at ga: latest must only
#                              ever point at a GA. pnpm packs and the npm CLI publishes the tarball through
#                              Trusted Publishing (OIDC, npm >= 11.5.1), so no token is read. A package whose
#                              publishConfig.registry names another registry is refused. The tarball is scanned
#                              before it is published.
#   pyproject.toml  PyPI       the SemVer version is written by release-please as is (0.3.0-alpha.1); the build
#                              backend normalizes it to PEP 440 (0.3.0a1), and the version published is read back
#                              from the built wheel, not converted here. PyPI has no dist-tags: pip skips
#                              pre-releases unless asked (--pre). Uploaded with Trusted Publishing.
#   Cargo.toml      crates.io  SemVer as is; cargo skips pre-releases unless the requirement names one. The
#                              CARGO_REGISTRY_TOKEN comes from crates.io Trusted Publishing (publish.yml).
#   go.mod          Go         nothing is uploaded: the tag go/vX.Y.Z is the release, the Go proxy reads it.
#   Package.swift   SwiftPM    nothing is uploaded: the bare tag X.Y.Z at the repository root is the release.
# Every unit's version must belong to <stage> (version_stage in scripts/lib/release-stages.sh), so a dispatch
# with the wrong stage stops instead of publishing a prerelease under latest. A version that is already on the
# registry is skipped, so a re-run is safe. The unit's own file must carry the version in
# .release-please-manifest.json (the Go unit has no such file).
#
# usage: publish-units.sh <alpha|beta|rc|ga> <path>...
#        publish-units.sh --registries <path>...    print npm=true / pypi=true / crates=true / go=true / swift=true
#                                                   for the registries the paths need ($GITHUB_OUTPUT format)
#        publish-units.sh --crate-exists <path>...  exit 0 when every crates.io unit among the paths already has
#                                                   its crate on crates.io, 1 when one has not, 2 when crates.io
#                                                   cannot be asked. Trusted Publishing can only be set up for a
#                                                   crate that exists, so the first version is published by hand.
#   PUBLISH_OUT         where packages are built (default tmp/publish): npm tarballs in <unit folder>/, Python
#                       wheels and sdists in pypi/. Keep them apart: the PyPI upload takes every file of pypi/.
#   PUBLISH_REGISTRIES  comma list (npm,pypi,crates,go,swift): publish only the units of these registries. The
#                       checks still run for every unit. publish.yml has one job per registry.
#   PUBLISH_DRY_RUN     1 makes every upload a dry run (npm publish, uv publish, cargo publish --dry-run)
#   PUBLISH_CHECK_ONLY  1 stops after the checks (file version, stage, same content as the tag), before the
#                       registry lookup, packing and upload. Used by publish-units.test.ts.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
cd "$REPO_ROOT"
usage="usage: publish-units.sh <alpha|beta|rc|ga> <path>... | publish-units.sh --registries <path>... | publish-units.sh --crate-exists <path>..."

registry() { # registry <path> → npm | pypi | crates | go | swift
  unit_registry "$1" || die "$1 has no package.json, pyproject.toml, Cargo.toml, go.mod or Package.swift, so the registry is unknown"
}

toml_get() { # toml_get <file> <table> <key>
  python3 -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))[sys.argv[2]][sys.argv[3]])' "$@"
}

npm_dist_tag() { if [[ "$1" == ga ]]; then printf '%s\n' latest; else printf '%s\n' "$1"; fi; }

summary() { [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf '%s\n' "- $*" >> "$GITHUB_STEP_SUMMARY"; }

# DRY_NOTE is " (dry-run)" in a dry run and empty otherwise, for the log and summary lines
dry_run() { [[ "${PUBLISH_DRY_RUN:-0}" == 1 ]]; }
DRY_NOTE=""; dry_run && DRY_NOTE=" (dry-run)"

# wanted <registry> → whether the run publishes units of that registry (PUBLISH_REGISTRIES unset means all)
wanted() {
  local -a only=()
  [[ -n "${PUBLISH_REGISTRIES:-}" ]] || return 0
  IFS=, read -r -a only <<<"$PUBLISH_REGISTRIES"
  in_array "$1" "${only[@]}"
}

# The unit's own file must carry the manifest version: release-please writes both in one commit, and
# a broken updater would otherwise publish a version the manifest never released.
check_file_version() { # check_file_version <path> <file> <version in file> <manifest version>
  [[ "$3" == "$4" ]] || die "$1: manifest says $4 but $2 says ${3:-(empty)}; release-please did not update that file"
}

# A publish that failed after its tag was made can be dispatched again from the release branch once the fix
# lands there. That is only safe while the unit's own files still equal the tag: otherwise one version number
# would name two different packages. publish.yml's checkout is shallow and carries no tags, so a shallow clone
# fetches the tag first; a unit without a tag has nothing to compare. The tag shape comes from the config
# (unit_tag), and the files compared are the unit's own (unit_content_paths): for the Swift unit at ".", not the
# whole repository, which would also take in js/ and every file a later release commit touches.
check_same_as_tag() { # check_same_as_tag <path> <version>
  local t; t="$(unit_tag "$1" "$2")"
  local -a content
  mapfile -t content < <(unit_content_paths "$1")
  if ! git rev-parse -q --verify "refs/tags/$t" >/dev/null 2>&1; then
    [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == true ]] || return 0
    git fetch -q --depth=1 origin "refs/tags/$t:refs/tags/$t" 2>/dev/null || return 0
  fi
  git diff --quiet "$t" HEAD -- "${content[@]}" \
    || die "$1 的內容和 tag $t 不同。修正動到套件本身時，要推進到下一個序號重發，不能用同一個版號"
}

# A package must not carry the shared samples: they sit beside the readers in the repository and are not part
# of any of them. A file listing (stdin) that names a conformance/ directory stops the run before the upload.
check_no_conformance() { # check_no_conformance <what>
  if grep -E '(^|/)conformance/' >/dev/null; then die "$1 contains conformance/; it must not be published"; fi
}

publish_npm() { # publish_npm <path> <version> <stage>
  local p="$1" ver="$2" stage="$3" name reg tgz out
  local -a dry=()
  [[ -f "$p/package.json" ]] || die "$p/package.json not found"
  name="$(jq -r .name "$p/package.json")"
  reg="$(jq -r '.publishConfig.registry // "https://registry.npmjs.org"' "$p/package.json")"
  [[ "$reg" == "https://registry.npmjs.org" ]] || die "$p: publishConfig.registry is $reg, only https://registry.npmjs.org is supported"

  if [[ "${PUBLISH_CHECK_ONLY:-0}" == 1 ]]; then
    echo "check only: $name@$ver passed (stage $stage, dist-tag $(npm_dist_tag "$stage")); nothing packed or published"; return 0
  fi
  wanted npm || return 0

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

  dry_run && dry=(--dry-run)
  echo "publishing $name@$ver to $reg with dist-tag $(npm_dist_tag "$stage") ${dry[*]:-}"
  npm publish "$tgz" --access public --tag "$(npm_dist_tag "$stage")" --registry "$reg" ${dry[@]+"${dry[@]}"}
  summary "published \`$name@$ver\` to $reg, dist-tag \`$(npm_dist_tag "$stage")\` ${dry[*]:-}"
}

publish_pypi() { # publish_pypi <path> <version> <stage>
  local p="$1" ver="$2" name build out pyver
  name="$(toml_get "$p/pyproject.toml" project name)"
  if [[ "${PUBLISH_CHECK_ONLY:-0}" == 1 ]]; then
    echo "check only: $name $ver passed (stage $3, PyPI); nothing built or published"; return 0
  fi
  wanted pypi || return 0
  build="$PUBLISH_OUT/build/$(unit_component "$p")" out="$PUBLISH_OUT/pypi"
  rm -rf "$build"; mkdir -p "$build" "$out"
  uv build --quiet --sdist --wheel --out-dir "$build" "$p"
  pyver="$(python3 - "$build" <<'PY'
import pathlib, sys, zipfile
wheel = next(pathlib.Path(sys.argv[1]).glob("*.whl"))
with zipfile.ZipFile(wheel) as z:
    meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
    print(next(l for l in z.read(meta).decode().splitlines() if l.startswith("Version: "))[9:])
PY
)"
  python3 - "$build" <<'PY' | check_no_conformance "the wheel or sdist of $name"
import pathlib, sys, tarfile, zipfile
root = pathlib.Path(sys.argv[1])
for wheel in root.glob("*.whl"):
    print("\n".join(zipfile.ZipFile(wheel).namelist()))
for sdist in root.glob("*.tar.gz"):
    print("\n".join(tarfile.open(sdist).getnames()))
PY
  if curl -fsS -o /dev/null "https://pypi.org/pypi/$name/$pyver/json" 2>/dev/null; then
    info "PyPI：$name $pyver 已發布，略過"; return 0
  fi
  mv "$build"/* "$out"/
  log "PyPI：${name} ${ver} → ${pyver}（PEP 440，取自建置出的 wheel）"
  summary "PyPI \`${name} ${pyver}\`（版號 ${ver}）${DRY_NOTE}"
}

# One upload for every Python unit of the run, from a directory that holds nothing but their wheels and sdists.
# --check-url skips files PyPI already has. A dry run keeps Trusted Publishing off so it never asks PyPI for a
# token; the real upload sets --trusted-publishing always, which takes the job's OIDC token (id-token: write).
upload_pypi() {
  local out="$PUBLISH_OUT/pypi"
  compgen -G "$out/*" >/dev/null || return 0
  log "PyPI：上傳 $(find "$out" -type f | wc -l | tr -d ' ') 個檔${DRY_NOTE}"
  if dry_run; then
    uv publish --dry-run --trusted-publishing never --check-url https://pypi.org/simple/ "$out/"*
  else
    uv publish --trusted-publishing always --check-url https://pypi.org/simple/ "$out/"*
  fi
}

# crates_status <name> → exists | absent. Anything but a 200 or a 404 fails: a network error must not read as
# "the crate does not exist".
crates_status() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -A "fact-kit publish check" "https://crates.io/api/v1/crates/$1" 2>/dev/null || true)"
  case "$code" in 200) echo exists ;; 404) echo absent ;; *) warn "crates.io answered ${code:-nothing} for the crate $1"; return 1 ;; esac
}

publish_crates() { # publish_crates <path> <version> <stage>
  local p="$1" ver="$2" name
  local -a dry=()
  name="$(toml_get "$p/Cargo.toml" package name)"
  if [[ "${PUBLISH_CHECK_ONLY:-0}" == 1 ]]; then
    echo "check only: $name $ver passed (stage $3, crates.io); nothing packed or published"; return 0
  fi
  wanted crates || return 0
  cargo package --list --locked --allow-dirty --manifest-path "$p/Cargo.toml" 2>/dev/null | check_no_conformance "the crate $name"
  if curl -fsS -o /dev/null -A "fact-kit publish check" "https://crates.io/api/v1/crates/$name/$ver" 2>/dev/null; then
    info "crates.io：$name $ver 已發布，略過"; return 0
  fi
  dry_run && dry=(--dry-run)
  log "crates.io：${name} ${ver}${DRY_NOTE}"
  cargo publish --locked --manifest-path "$p/Cargo.toml" ${dry[@]+"${dry[@]}"}
  summary "crates.io \`$name $ver\`${DRY_NOTE}"
}

# Go and Swift: nothing to upload. release-please creates the tag when the Release PR merges, and the tag is the
# release: the Go proxy resolves go/vX.Y.Z, SwiftPM resolves the bare X.Y.Z. A real run requires the tag to exist.
publish_tag() { # publish_tag <path> <version> <stage> <go|swift>
  local p="$1" ver="$2" what t
  t="$(unit_tag "$p" "$ver")"
  if [[ "$4" == go ]]; then what="Go module $(sed -n 's/^module //p' "$p/go.mod")"
  else what="Swift package $(sed -n 's/^ *name: *"\([^"]*\)".*/\1/p' "$p/Package.swift" | head -1)"; fi
  if [[ "${PUBLISH_CHECK_ONLY:-0}" == 1 ]]; then
    echo "check only: $what $ver passed (stage $3, tag $t); nothing to upload"; return 0
  fi
  wanted "$4" || return 0
  if ! git rev-parse -q --verify "refs/tags/$t" >/dev/null 2>&1; then
    if dry_run; then info "tag $t 還沒建立（dry-run，合併 Release PR 時由 release-please 建立）"
    else
      git fetch -q --depth=1 origin "refs/tags/$t:refs/tags/$t" 2>/dev/null || true
      git rev-parse -q --verify "refs/tags/$t" >/dev/null 2>&1 || die "tag $t does not exist, so ${what} ${ver} has not been released"
    fi
  fi
  log "${4^}：${what} ${ver}，tag $t 即發布，不上傳${DRY_NOTE}"
  summary "${4^} \`$what $ver\`，tag \`$t\`（不上傳）"
}

[[ $# -ge 2 ]] || die "$usage"
case "$1" in
  --registries)
    shift
    regs=()
    for p in "$@"; do r="$(registry "${p%/}")"; regs+=("$r=true"); done
    printf '%s\n' "${regs[@]}" | sort -u
    exit 0 ;;
  --crate-exists)
    shift
    for p in "$@"; do
      p="${p%/}"
      [[ "$(registry "$p")" == crates ]] || continue
      status="$(crates_status "$(toml_get "$p/Cargo.toml" package name)")" || exit 2
      [[ "$status" == exists ]] || exit 1
    done
    exit 0 ;;
esac

stage="$1"
is_stage "$stage" || die "stage \"${stage}\" is not alpha, beta, rc or ga. $usage"
shift
PUBLISH_OUT="${PUBLISH_OUT:-$REPO_ROOT/tmp/publish}"
rm -rf "$PUBLISH_OUT/pypi"
for u in "$@"; do
  u="${u%/}"
  jq -e --arg p "$u" '.packages | has($p)' "$CONFIG" >/dev/null 2>&1 \
    || die "unexpected package path: $u (not a key of packages in $CONFIG)"
  reg="$(registry "$u")"
  ver="$(manifest_version "$u")"
  [[ -n "$ver" ]] || die "$u is not in $MANIFEST"
  case "$reg" in
    npm) check_file_version "$u" "$u/package.json" "$(jq -r .version "$u/package.json")" "$ver" ;;
    pypi) check_file_version "$u" "$u/pyproject.toml" "$(toml_get "$u/pyproject.toml" project version)" "$ver" ;;
    crates) check_file_version "$u" "$u/Cargo.toml" "$(toml_get "$u/Cargo.toml" package version)" "$ver" ;;
    swift) [[ ! -f "$u/version.txt" ]] || check_file_version "$u" "$u/version.txt" "$(tr -d '[:space:]' < "$u/version.txt")" "$ver" ;;
  esac
  vs="$(version_stage "$ver")" || die "$u: version $ver is not X.Y.Z or X.Y.Z-<alpha|beta|rc>.N, so its release stage is unknown"
  [[ "$vs" == "$stage" ]] || die "$u: version $ver belongs to stage $vs, but this release's stage is $stage"
  check_same_as_tag "$u" "$ver"
  case "$reg" in
    npm) publish_npm "$u" "$ver" "$stage" ;;
    pypi) publish_pypi "$u" "$ver" "$stage" ;;
    crates) publish_crates "$u" "$ver" "$stage" ;;
    go | swift) publish_tag "$u" "$ver" "$stage" "$reg" ;;
  esac
done
if [[ "${PUBLISH_CHECK_ONLY:-0}" != 1 ]] && wanted pypi; then upload_pypi; fi
exit 0
