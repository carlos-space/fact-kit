#!/usr/bin/env bash
# Assembled-system check: pack each package that release-please-config.json lists, install what was packed
# into an empty place and run a smoke test against what was installed, not against the sources. Unit
# tests prove the sources; this proves the published shape (files whitelist, exports, bin) still works.
#   npm units     pnpm pack, then npm install of the tarballs into an empty directory
#   fact-kit      consumer/js/run.sh --local <tgz>: a new npm project installs the tarball
#   fact-kit-facts  read through the installed fact-kit with readFacts
#   py            uv build, then consumer/py/run.sh --local <wheel>: a new virtual environment holds the wheel
#   rs            cargo package (which builds the packaged crate), then consumer/rs/run.sh --local <.crate>
#   go            the module directory copied out, then consumer/go/run.sh --local <copy>
#   swift         only the files SwiftPM needs (unit_content_paths, LICENSE) copied out, then
#                 consumer/swift/run.sh --local <copy>; the copy holds no js/ and no facts/
# The consumer harnesses read the shared samples of conformance/ and print where the package was loaded from.
# On a release branch the config lists only the train's packages, so this checks what the train ships.
# Run after `pnpm build`; ci.yml runs it on push to release/**.
# usage: assembled-check.sh        env: ASSEMBLED_ALLOW_DIRTY=1  let `cargo package` run on a modified tree
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
root="$REPO_ROOT"
cd "$root"
work="$root/tmp/assembled"
rm -rf "$work"; mkdir -p "$work/packed" "$work/app"

mapfile -t paths < <(jq -r '.packages | keys[]' release-please-config.json)
npm_units=()
for p in "${paths[@]}"; do
  [[ "$(unit_registry "$p")" == npm ]] || continue
  npm_units+=("$p"); (cd "$p" && pnpm pack --pack-destination "$work/packed" >/dev/null)
done
if (( ${#npm_units[@]} )); then
  printf '%s\n' "packed: $(find "$work/packed" -name '*.tgz' -exec basename {} \; | paste -sd' ' -)"
  cd "$work/app"
  printf '%s\n' '{"name":"assembled-check","private":true,"type":"module"}' > package.json
  npm install --no-audit --no-fund --silent "$work"/packed/*.tgz
fi
cd "$work/app"

# A package must not carry the shared samples; stdin is the list of files of one package.
no_conformance() { # no_conformance <what>
  if grep -E '(^|/)conformance/' >/dev/null; then printf '%s\n' "$1 contains conformance/" >&2; return 1; fi
}

for p in "${paths[@]}"; do
  comp="$(jq -r --arg p "$p" '.packages[$p].component // empty' "$root/release-please-config.json")"
  case "${comp:-$p}" in
    fact-kit)
      bash "$root/consumer/js/run.sh" --local "$work"/packed/fact-kit-[0-9]*.tgz ;;
    fact-kit-facts)
      # Read through fact-kit, as a consumer does. A train without fact-kit reads with the published one.
      [[ -d node_modules/fact-kit ]] || npm install --no-audit --no-fund --silent fact-kit
      node --input-type=module -e "
        import { readFacts } from 'fact-kit'
        const r = readFacts('fact-kit-facts')
        if (!r.has('fact-kit.fact') || r.facts.length === 0) throw new Error('fact-kit-facts has no fact-kit.fact')" ;;
    py)
      uv build --quiet --wheel --out-dir "$work/packed-py" "$root/$p"
      unzip -Z1 "$work"/packed-py/*.whl | no_conformance "the wheel of $p"
      bash "$root/consumer/py/run.sh" --local "$work"/packed-py/*.whl ;;
    rs)
      cargo_args=(--locked --manifest-path "$root/$p/Cargo.toml" --target-dir "$work/cargo-target")
      [[ "${ASSEMBLED_ALLOW_DIRTY:-0}" != 1 ]] || cargo_args+=(--allow-dirty)
      cargo package "${cargo_args[@]}"
      tar -tzf "$work"/cargo-target/package/*.crate | no_conformance "the crate of $p"
      bash "$root/consumer/rs/run.sh" --local "$work"/cargo-target/package/*.crate ;;
    go)
      mkdir -p "$work/go-module"; cp -R "$root/$p/." "$work/go-module/"
      bash "$root/consumer/go/run.sh" --local "$work/go-module" ;;
    swift)
      # what SwiftPM needs from the repository root: Package.swift, Package.resolved, Sources/, Tests/ (the
      # manifest declares a test target, so SwiftPM wants the directory) and the license
      mkdir -p "$work/swift-package"
      while IFS= read -r f; do [[ -e "$root/$f" ]] && cp -R "$root/$f" "$work/swift-package/"; done < <(cd "$root" && unit_content_paths "$p" | sed 's#^\./##')
      cp "$root/LICENSE" "$work/swift-package/"
      (cd "$work/swift-package" && find . -not -path './Sources/*' -not -path './Tests/*' | sort | sed 's/^/  assembled /')
      for d in js facts conformance py rs go scripts; do
        [[ ! -e "$work/swift-package/$d" ]] || { printf '%s\n' "the Swift package contains $d/" >&2; exit 1; }
      done
      bash "$root/consumer/swift/run.sh" --local "$work/swift-package" ;;
    *) printf '%s\n' "no smoke test for $p (component ${comp:-none})" >&2; exit 1 ;;
  esac
  printf '%s\n' "✓ $p"
done
