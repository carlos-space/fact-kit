#!/usr/bin/env bash
# Assembled-system check: pack each package that release-please-config.json lists, install the tarballs
# into an empty directory and run a smoke test against what was installed, not against the sources. Unit
# tests prove the sources; this proves the published shape (files whitelist, exports, bin) still works.
# On a release branch the config lists only the train's packages, so this checks what the train ships.
# Run after `pnpm build`; ci.yml runs it on push to release/**.
# usage: assembled-check.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
work="$root/tmp/assembled"
rm -rf "$work"; mkdir -p "$work/packed" "$work/app"

mapfile -t paths < <(jq -r '.packages | keys[]' release-please-config.json)
for p in "${paths[@]}"; do (cd "$p" && pnpm pack --pack-destination "$work/packed" >/dev/null); done
printf '%s\n' "packed: $(find "$work/packed" -name '*.tgz' -exec basename {} \; | paste -sd' ' -)"

cd "$work/app"
printf '%s\n' '{"name":"assembled-check","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund --silent "$work"/packed/*.tgz

for p in "${paths[@]}"; do
  comp="$(jq -r --arg p "$p" '.packages[$p].component // empty' "$root/release-please-config.json")"
  case "${comp:-$p}" in
    fact-kit)
      node --input-type=module -e "
        import { defineFacts, checkFacts } from 'fact-kit'
        if (typeof defineFacts !== 'function' || typeof checkFacts !== 'function') throw new Error('fact-kit exports are missing')"
      ./node_modules/.bin/fact-kit --help | grep -q '^Commands' ;;
    fact-kit-facts)
      # Read through fact-kit, as a consumer does. A train without fact-kit reads with the published one.
      [[ -d node_modules/fact-kit ]] || npm install --no-audit --no-fund --silent fact-kit
      node --input-type=module -e "
        import { readFacts } from 'fact-kit'
        const r = readFacts('fact-kit-facts')
        if (!r.has('fact-kit.fact') || r.facts.length === 0) throw new Error('fact-kit-facts has no fact-kit.fact')" ;;
    *) printf '%s\n' "no smoke test for $p (component ${comp:-none})" >&2; exit 1 ;;
  esac
  printf '%s\n' "✓ $p"
done
