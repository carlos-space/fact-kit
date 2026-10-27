#!/usr/bin/env bash
# Build a small program that imports the fact-kit Go module and run the shared samples through it.
#   run.sh <version>         require github.com/carlos-space/fact-kit/go@v<version> (the registry check, through
#                            the Go proxy)
#   run.sh --local <dir>     replace the module with a local directory that holds its go.mod (the local check)
# The program lives in a temporary directory, so nothing in this repository is a path dependency.
# env: FACT_KIT_CONFORMANCE  the conformance/ directory (default: ../../conformance from this file)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export FACT_KIT_CONFORMANCE="${FACT_KIT_CONFORMANCE:-$(cd "$here/../../conformance" && pwd)}"
module=github.com/carlos-space/fact-kit/go
local_dir=""
if [[ "${1:-}" == --local ]]; then
  [[ -f "${2:-}/go.mod" ]] || { echo "usage: run.sh <version> | run.sh --local <module dir>" >&2; exit 2; }
  local_dir="$(cd "$2" && pwd)"
fi
work="$(mktemp -d)"; trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
cp "$here/main.go" "$work/"
cd "$work"
go mod init consumer >/dev/null 2>&1
go mod edit -go=1.26

if [[ -n "$local_dir" ]]; then
  go mod edit -require="$module@v0.0.0" -replace "$module=$local_dir"
elif [[ -n "${1:-}" ]]; then
  # the proxy may need a moment after the tag is pushed; GOFLAGS=-mod=mod lets go add go.sum entries
  go mod edit -require="$module@v${1#v}"
else
  echo "usage: run.sh <version> | run.sh --local <module dir>" >&2; exit 2
fi
export GOFLAGS=-mod=mod
go mod tidy
echo "source: go list -m $module"
go list -m -json "$module" | jq -r '"  path \(.Path)\n  version \(.Version)\n  dir \(.Dir)" + (if .Origin then "\n  origin \(.Origin.URL // "") \(.Origin.Ref // "") \(.Origin.Hash // "")" else "" end) + (if .Replace then "\n  replace \(.Replace.Path) \(.Replace.Version // "")" else "" end)'
go run .
