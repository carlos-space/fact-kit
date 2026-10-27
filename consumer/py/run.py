"""Consumer harness for the Python reader: runs the shared samples of conformance/ against an installed fact-kit.

It imports only what the installed package exports, and run.sh starts it with `python -I` from a virtual
environment that holds nothing of this repository, so a copy of the sources next to it cannot be loaded by
accident. It prints where the package was loaded from, and exits 1 when a sample fails or the package was not
loaded from site-packages.

usage: run.py [--expect-version X.Y.Z[-pre.N]]      env: FACT_KIT_CONFORMANCE  the conformance/ directory
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import sys
from pathlib import Path
from typing import Any

import fact_kit
from fact_kit import FactReadError, compare_versions, read_facts, release_line, select_facts


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def utf16_key(text: str) -> bytes:
    return text.encode("utf-16-be", "surrogatepass")


def same(a: Any, b: Any) -> bool:
    """Equality as JavaScript's deep equality sees JSON: 1 equals 1.0, a bool is not a number, key order is ignored."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def outcome(run) -> dict[str, Any]:
    """What a reader returns, in the shape of expected.json, or the error code it raised."""
    try:
        facts = []
        for f in run():
            item = {"id": f["id"], "content": f["content"], "since": f["since"]}
            if "stability" in f:
                item["stability"] = f["stability"]
            facts.append(item)
        facts.sort(key=lambda f: utf16_key(f["id"]))
        return {"facts": facts}
    except FactReadError as error:
        return {"error": error.code}


def normalize(version: str) -> str:
    try:
        from packaging.version import Version

        return str(Version(version))
    except ImportError:
        return version


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect-version")
    args = parser.parse_args()

    env = os.environ.get("FACT_KIT_CONFORMANCE")
    if not env:
        print("FACT_KIT_CONFORMANCE is not set", file=sys.stderr)
        return 1
    root = Path(env).resolve()
    failures: list[str] = []

    def check(name: str, got: Any, want: Any) -> None:
        if not same(got, want):
            failures.append(f"{name}\n  got      {json.dumps(got)}\n  expected {json.dumps(want)}")

    cases = sorted(p.name for p in (root / "cases").iterdir() if p.is_dir())
    for name in cases:
        d = root / "cases" / name
        query = read_json(d / "query.json")
        got = outcome(lambda: select_facts(read_json(d / "index.json"), **query))
        check(f"cases/{name}", got, read_json(d / "expected.json"))

    resolves = sorted(p.name for p in (root / "resolve").iterdir() if p.is_dir())
    for name in resolves:
        d = root / "resolve" / name
        query = read_json(d / "query.json")
        spec = query.pop("spec")
        got = outcome(lambda: read_facts(spec, root=d / "root", **query).facts)
        check(f"resolve/{name}", got, read_json(d / "expected.json"))

    compares = lines = 0
    for entry in read_json(root / "semver.json"):
        if "a" in entry:
            compares += 1
            check(f"semver/{entry['a']} vs {entry['b']}", compare_versions(entry["a"], entry["b"]), entry["expected"])
        else:
            lines += 1
            check(f"semver/line {entry['version']}", release_line(entry["version"]), entry["line"])

    # a harness that read nothing proves nothing
    if len(cases) < 80 or len(resolves) < 15 or compares <= 50 or lines <= 5:
        failures.append(f"too few samples in {root}: {len(cases)} cases, {len(resolves)} resolve, {compares} compares, {lines} lines")

    module = Path(fact_kit.__file__).resolve()
    version = importlib.metadata.version("fact-kit")
    print(f"python: {sys.version.split()[0]} at {sys.executable}")
    print(f"conformance: {root}")
    print(f"samples: {len(cases)} cases, {len(resolves)} resolve, {compares} version comparisons, {lines} release lines")
    print(f"source: module fact_kit loaded from {module}")
    print(f"source: distribution fact-kit {version}")
    direct = importlib.metadata.distribution("fact-kit").read_text("direct_url.json")
    if direct:
        print(f"source: installed from {json.loads(direct).get('url')}")
    if "site-packages" not in module.parts:
        failures.append(f"fact_kit was loaded from {module}, which is not an installed copy")
    if args.expect_version and normalize(version) != normalize(args.expect_version):
        failures.append(f"installed fact-kit {version}, expected {args.expect_version}")

    if failures:
        print(f"FAILED: {len(failures)}", file=sys.stderr)
        for f in failures:
            print(f, file=sys.stderr)
        return 1
    print("ok: every sample matches expected.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
