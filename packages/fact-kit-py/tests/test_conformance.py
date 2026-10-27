"""Runs the shared samples in conformance/ against the public API of fact_kit.

The body only uses what the package exports, so the same file can test an installed copy.
Set FACT_KIT_CONFORMANCE to point at conformance/, otherwise it is looked up from this file upward.
"""

from __future__ import annotations

from typing import Any

import pytest
from fact_kit import FactReadError, compare_versions, read_facts, release_line, select_facts
from helpers import case_dirs, conformance_dir, read_json, same, utf16_key

CASES = case_dirs("cases")
RESOLVE = case_dirs("resolve")
SEMVER = read_json(conformance_dir() / "semver.json")
COMPARES = [e for e in SEMVER if "a" in e]
LINES = [e for e in SEMVER if "version" in e]


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


def test_samples_exist() -> None:
    root = conformance_dir()
    assert len(CASES) >= 80
    assert len(RESOLVE) >= 15
    assert len(COMPARES) > 50
    assert len(LINES) > 5
    for name in CASES:
        for file in ("index.json", "query.json", "expected.json"):
            assert (root / "cases" / name / file).exists(), f"{name}/{file}"


@pytest.mark.parametrize("name", CASES)
def test_select_case(name: str) -> None:
    directory = conformance_dir() / "cases" / name
    query = read_json(directory / "query.json")
    got = outcome(lambda: select_facts(read_json(directory / "index.json"), **query))
    assert same(got, read_json(directory / "expected.json")), got


@pytest.mark.parametrize("name", RESOLVE)
def test_resolve_case(name: str) -> None:
    directory = conformance_dir() / "resolve" / name
    query = read_json(directory / "query.json")
    spec = query.pop("spec")
    got = outcome(lambda: read_facts(spec, root=directory / "root", **query).facts)
    assert same(got, read_json(directory / "expected.json")), got


@pytest.mark.parametrize("entry", COMPARES, ids=lambda e: f"{e['a']}-vs-{e['b']}")
def test_compare_versions(entry: dict[str, Any]) -> None:
    assert compare_versions(entry["a"], entry["b"]) == entry["expected"]


@pytest.mark.parametrize("entry", LINES, ids=lambda e: f"line-{e['version']}")
def test_release_line(entry: dict[str, Any]) -> None:
    assert release_line(entry["version"]) == entry["line"]
