#!/usr/bin/env bash
# Scan an unpacked npm tarball for what must not ship: local absolute paths in any text file, and, for
# every index.json inside, the same rules `fact-kit check` applies (local paths, unregistered domains).
# The patterns mirror js/src/check.ts. The allowed domains come from the package's
# fact-kit.config.json, which does not ship; its other settings are paths in the source tree, so only
# allowedDomains is passed on.
# usage: scan-tarball.sh <unpacked tarball dir> <package source dir>      exit 1 on any finding
set -euo pipefail
dir="${1:?usage: scan-tarball.sh <dir> <package dir>}"
pkg="${2:?usage: scan-tarball.sh <dir> <package dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
bad=0

allow=()
if [[ -f "$pkg/fact-kit.config.json" ]]; then
  while IFS= read -r d; do allow+=(--allow-domain "$d"); done < <(
    node -e 'for (const d of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).allowedDomains ?? []) console.log(d)' \
      "$pkg/fact-kit.config.json"
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
