#!/usr/bin/env bash
# Build a small crate that depends on fact-kit and run the shared samples through it.
#   run.sh <version>         depend on fact-kit =<version> from crates.io (the registry check)
#   run.sh --local <path>    depend on a local copy through [patch.crates-io]: a directory with a Cargo.toml,
#                            or a .crate file made by `cargo package` (the local check)
# The harness crate lives in a temporary directory, so nothing in this repository is a path dependency.
# env: FACT_KIT_CONFORMANCE  the conformance/ directory (default: ../../conformance from this file)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export FACT_KIT_CONFORMANCE="${FACT_KIT_CONFORMANCE:-$(cd "$here/../../conformance" && pwd)}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src"; cp "$here/src/main.rs" "$work/src/"

patch=""
if [[ "${1:-}" == --local ]]; then
  [[ -e "${2:-}" ]] || { echo "usage: run.sh <version> | run.sh --local <dir|.crate>" >&2; exit 2; }
  src="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$work/local"; tar -xzf "$src" -C "$work/local" --strip-components=1; src="$work/local"
  fi
  src="$(cd "$src" && pwd)"
  version="$(python3 -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["package"]["version"])' "$src/Cargo.toml")"
  patch=$'\n[patch.crates-io]\nfact-kit = { path = "'"$src"'" }'
elif [[ -n "${1:-}" ]]; then
  version="$1"
else
  echo "usage: run.sh <version> | run.sh --local <dir|.crate>" >&2; exit 2
fi

cat > "$work/Cargo.toml" <<TOML
[package]
name = "fact-kit-consumer"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
fact-kit = "=${version}"
serde_json = { version = "1", features = ["preserve_order"] }
${patch}
TOML

cd "$work"
cargo build --quiet
echo "source: fact-kit =${version} resolved by cargo:"
cargo metadata --format-version 1 | jq -r '.packages[] | select(.name == "fact-kit") | "  id \(.id)\n  version \(.version)\n  source \(.source // "path (local copy)")\n  manifest \(.manifest_path)"'
cargo tree --depth 0 --package fact-kit | sed 's/^/  tree /'
cargo run --quiet
