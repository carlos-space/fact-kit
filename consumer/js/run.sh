#!/usr/bin/env bash
# Install fact-kit into a new npm project and run the shared samples against it.
#   run.sh <version>         npm install fact-kit@<version> from the npm registry (the registry check)
#   run.sh --local <tgz>     npm install a tarball made by `pnpm pack` (the local check)
# The project lives in a temporary directory, so nothing in this repository is a path dependency.
# env: FACT_KIT_CONFORMANCE  the conformance/ directory (default: ../../conformance from this file)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export FACT_KIT_CONFORMANCE="${FACT_KIT_CONFORMANCE:-$(cd "$here/../../conformance" && pwd)}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

if [[ "${1:-}" == --local ]]; then
  [[ -f "${2:-}" ]] || { echo "usage: run.sh <version> | run.sh --local <tgz>" >&2; exit 2; }
  requirement="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; expect=()
elif [[ -n "${1:-}" ]]; then
  requirement="fact-kit@${1#v}"; expect=(--expect-version "${1#v}")
else
  echo "usage: run.sh <version> | run.sh --local <tgz>" >&2; exit 2
fi

cd "$work"
printf '%s\n' '{"name":"consumer-js","private":true,"type":"module"}' > package.json
# the harness is copied in so that `fact-kit` resolves from this project's node_modules and nowhere else
cp "$here/run.mjs" "$work/"
npm install --no-audit --no-fund --silent --no-package-lock "$requirement"
node run.mjs ${expect[@]+"${expect[@]}"}
