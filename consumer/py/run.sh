#!/usr/bin/env bash
# Install fact-kit into a new virtual environment and run the shared samples against it.
#   run.sh <version>          install fact-kit==<version> from PyPI (the registry check)
#   run.sh --local <wheel>    install a wheel built here, e.g. from `uv build` (the local check)
# <version> may be written SemVer style (0.3.0-alpha.1); pip and uv normalize it to PEP 440 (0.3.0a1).
# env: FACT_KIT_CONFORMANCE  the conformance/ directory (default: ../../conformance from this file)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export FACT_KIT_CONFORMANCE="${FACT_KIT_CONFORMANCE:-$(cd "$here/../../conformance" && pwd)}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

if [[ "${1:-}" == --local ]]; then
  [[ -f "${2:-}" ]] || { echo "usage: run.sh <version> | run.sh --local <wheel>" >&2; exit 2; }
  requirement="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; expect=()
elif [[ -n "${1:-}" ]]; then
  requirement="fact-kit==$1"; expect=(--expect-version "$1")
else
  echo "usage: run.sh <version> | run.sh --local <wheel>" >&2; exit 2
fi

uv venv --quiet "$work/venv"
# --no-cache keeps a wheel an earlier run left in the cache from standing in for the one named here
uv pip install --quiet --no-cache --python "$work/venv/bin/python" packaging "$requirement"
# -I: no PYTHONPATH, no user site and no script directory on sys.path, so only the installed copy can load
"$work/venv/bin/python" -I "$here/run.py" ${expect[@]+"${expect[@]}"}
