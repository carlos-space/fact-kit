#!/usr/bin/env bash
# Scan an unpacked npm tarball for what must not ship: local absolute paths in any text file, and, for
# every index.json inside, the same rules `fact-kit check` applies (local paths, unregistered domains).
# The patterns mirror js/src/check.ts. The allowed domains come from the package's
# fact-kit.config.json, which does not ship; its other settings are paths in the source tree, so only
# allowedDomains is passed on. An aggregate package ships the indexes of the component packages its
# `aggregate` names, so their allowedDomains count too; each one is read from node_modules/<name>, where
# the aggregate's workspace:* devDependency links it.
# usage: scan-tarball.sh <unpacked tarball dir> <package source dir>      exit 1 on any finding
set -euo pipefail
dir="${1:?usage: scan-tarball.sh <dir> <package dir>}"
pkg="${2:?usage: scan-tarball.sh <dir> <package dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
bad=0

allow=()
if [[ -f "$pkg/fact-kit.config.json" ]]; then
  while IFS= read -r d; do allow+=(--allow-domain "$d"); done < <(
    node -e '
      const { readFileSync, existsSync } = require("fs"), { join } = require("path")
      const read = (f) => JSON.parse(readFileSync(f, "utf8"))
      const pkg = process.argv[1], own = read(join(pkg, "fact-kit.config.json"))
      const domains = new Set(own.allowedDomains ?? [])
      for (const name of Object.values(own.aggregate ?? {})) {
        const f = join(pkg, "node_modules", name, "fact-kit.config.json")
        if (!existsSync(f)) { console.error(`${name}: ${f} not found; run pnpm install first`); process.exit(1) }
        for (const d of read(f).allowedDomains ?? []) domains.add(d)
      }
      for (const d of domains) console.log(d)' "$pkg"
  )
fi

# POSIX/macOS home paths, Windows drive paths, file:// URLs
re='(^|[^[:alnum:]_.~:/-])/(Users|home|root)/[^[:space:]"'"'"'`<>)]+|[A-Za-z]:[\\/](Users|Windows|Program Files)[\\/][^[:space:]]|file:///[^[:space:]]'
if grep -rEnI "$re" "$dir"; then
  echo "::error::local absolute path found in the tarball (lines above)"; bad=1
fi

while IFS= read -r idx; do
  node "$root/js/src/bin.ts" check --cwd "$(mktemp -d)" --index "$idx" ${allow[@]+"${allow[@]}"} || bad=1
done < <(find "$dir" -name index.json -not -path '*/node_modules/*')

exit "$bad"
