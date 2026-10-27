#!/usr/bin/env bash
# Build a small package that depends on FactKit and run the shared samples through it.
#   run.sh <version>         depend on https://github.com/carlos-space/fact-kit at exactly <version>; SwiftPM
#                            reads the bare tag <version> (the check against the repository)
#   run.sh --local <dir>     depend on a local copy by path: a directory that holds Package.swift and Sources/
#                            (the local check)
# The package lives in a temporary directory. A local copy is copied there as fact-kit/, so the package gets the
# same identity (fact-kit) as the one cloned from the repository. SwiftPM has no registry for this package: the
# git tag is the release.
# env: FACT_KIT_CONFORMANCE  the conformance/ directory (default: ../../conformance from this file)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export FACT_KIT_CONFORMANCE="${FACT_KIT_CONFORMANCE:-$(cd "$here/../../conformance" && pwd)}"
work="$(mktemp -d)"; trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT

if [[ "${1:-}" == --local ]]; then
  [[ -f "${2:-}/Package.swift" ]] || { echo "usage: run.sh <version> | run.sh --local <package dir>" >&2; exit 2; }
  mkdir -p "$work/fact-kit"; rsync -a --exclude .build --exclude .git "$2/" "$work/fact-kit/"
  dependency='.package(path: "fact-kit")'
elif [[ -n "${1:-}" ]]; then
  dependency=".package(url: \"https://github.com/carlos-space/fact-kit\", exact: \"${1#v}\")"
else
  echo "usage: run.sh <version> | run.sh --local <package dir>" >&2; exit 2
fi

mkdir -p "$work/app/Sources"; cp -R "$here/Sources/consumer" "$work/app/Sources/"
if [[ -d "$work/fact-kit" ]]; then mv "$work/fact-kit" "$work/app/fact-kit"; fi
cat > "$work/app/Package.swift" <<SWIFT
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "consumer",
  platforms: [.macOS(.v13)],
  dependencies: [${dependency}],
  targets: [
    .executableTarget(name: "consumer", dependencies: [.product(name: "FactKit", package: "fact-kit")])
  ],
  swiftLanguageModes: [.v6]
)
SWIFT

cd "$work/app"
swift build 2>&1 | tail -3
echo "source: swift package show-dependencies"
swift package show-dependencies --format json | jq -r '.dependencies[] | "  \(.identity) \(.version) \(.url) at \(.path)"'
[[ ! -f Package.resolved ]] || { echo "source: Package.resolved"; jq -r '.pins[]? | "  \(.identity) \(.state.version // .state.branch) \(.state.revision)"' Package.resolved; }
swift run --skip-build consumer
