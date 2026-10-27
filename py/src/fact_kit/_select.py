"""Choose the facts one reader sees from a parsed ``index.json``."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import semver

from ._errors import FactReadError
from ._version import compare_lines, compare_semver, must_parse, parse_version

NO_SINCE = "0.0.0"
_MISSING: Any = object()

# A bound is (rank, version): rank 0 is -inf, 1 is a version, 2 is +inf ("next").
_Bound = tuple[int, semver.Version | None]
_MIN: _Bound = (0, None)
_MAX: _Bound = (2, None)


@dataclass(frozen=True)
class _Reader:
    kind: str  # "head", "latest" or "version"
    v: semver.Version | None = None


def _truthy(x: Any) -> bool:
    """JavaScript truthiness for a JSON value, so ``[]`` and ``{}`` count as set."""
    return not (x is None or x is False or x == "" or (isinstance(x, (int, float)) and x == 0))


def _compare_bounds(a: _Bound, b: _Bound) -> int:
    if a[0] != b[0]:
        return a[0] - b[0]
    if a[0] == 1:
        assert a[1] is not None and b[1] is not None
        return compare_semver(a[1], b[1])
    return 0


def _rows_of(fact: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The rows of a fact. Without ``variants`` the whole fact is one row that starts at ``when.since``."""
    variants = fact.get("variants")
    if isinstance(variants, list):
        rows = []
        for v in variants:
            if not isinstance(v, dict):
                continue
            row: dict[str, Any] = {}
            for key in ("since", "content", "pending", "stability", "platforms", "os"):
                if key in v:
                    row[key] = v[key]
            rows.append(row)
        return rows
    when = fact.get("when")
    when = when if isinstance(when, dict) else {}
    row = {}
    if "since" in when:
        row["since"] = when["since"]
    if "content" in fact:
        row["content"] = fact["content"]
    for key in ("platforms", "os"):
        if key in when:
            row[key] = when[key]
    return [row]


def _bound_of(since: Any, reader: _Reader, fact_id: str) -> _Bound | None:
    if since is _MISSING:
        return _MIN
    what = f"fact {fact_id}: since"
    if since == "next" and isinstance(since, str):
        return _MAX if reader.kind == "head" else None
    if isinstance(since, str):
        s = must_parse(since, what)
        if reader.kind == "version":
            assert reader.v is not None
            return (1, s) if compare_semver(reader.v, s) >= 0 else None
        return (1, s)
    if not isinstance(since, list):
        raise FactReadError("invalid-version", f"{what} must be a string or an array")
    has_next = any(isinstance(s, str) and s == "next" for s in since)
    versions = [must_parse(s, what) for s in since if not (isinstance(s, str) and s == "next")]
    if not versions:
        return _MAX if reader.kind == "head" else None
    newest = versions[0]
    for s in versions[1:]:
        if compare_semver(s, newest) > 0:
            newest = s
    if reader.kind == "version":
        assert reader.v is not None
        same = next((s for s in versions if compare_lines(s, reader.v) == 0), None)
        if same is not None:
            return (1, same) if compare_semver(reader.v, same) >= 0 else None
        # No version on the reader's line: the row applies once the reader's line is newer than all of them.
        return (1, newest) if all(compare_lines(reader.v, s) > 0 for s in versions) else None
    return _MAX if reader.kind == "head" and has_next else (1, newest)


def _specificity(row: Mapping[str, Any]) -> int:
    return (1 if _truthy(row.get("platforms")) else 0) + (1 if _truthy(row.get("os")) else 0)


def _contains(listed: Any, value: Any) -> bool:
    if isinstance(listed, (list, str)):
        return value in listed
    return False


def _canonical(row: Mapping[str, Any]) -> str:
    """The row as JSON with sorted keys and no whitespace, the text that breaks a tie."""
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _utf16(text: str) -> bytes:
    return text.encode("utf-16-be", "surrogatepass")


def _choose_row(
    rows: list[dict[str, Any]],
    reader: _Reader,
    include: Iterable[str],
    platform: str | None,
    os_name: str | None,
    fact_id: str,
) -> dict[str, Any] | None:
    best: tuple[dict[str, Any], _Bound] | None = None
    for row in rows:
        if "pending" in row and not (reader.kind == "head" and _contains(list(include), row["pending"])):
            continue
        if _truthy(row.get("platforms")) and (platform is None or not _contains(row["platforms"], platform)):
            continue
        if _truthy(row.get("os")) and (os_name is None or not _contains(row["os"], os_name)):
            continue
        bound = _bound_of(row.get("since", _MISSING), reader, fact_id)
        if bound is None:
            continue
        if best is None:
            best = (row, bound)
            continue
        order = _compare_bounds(bound, best[1]) or _specificity(row) - _specificity(best[0])
        # Equal rows are an author mistake that `check` reports. The canonical text keeps the result stable.
        if order > 0 or (order == 0 and _utf16(_canonical(row)) < _utf16(_canonical(best[0]))):
            best = (row, bound)
    return best[0] if best else None


def assert_index(index: Any, label: str = "the index") -> list[Any]:
    """Check the top of an index and return its facts. Raises ``not-an-index`` or ``unsupported-index-format``."""
    if not isinstance(index, dict):
        raise FactReadError("not-an-index", f"{label} is not a fact index")
    fmt = index["indexFormat"] if "indexFormat" in index else "1.0"
    m = re.fullmatch(r"([0-9]+)\.[0-9]+", fmt, re.ASCII) if isinstance(fmt, str) else None
    if m is None or int(m[1]) != 1:
        raise FactReadError(
            "unsupported-index-format",
            f"{label} has index format {json.dumps(fmt)}, and this reader takes 1.x",
        )
    facts = index.get("facts")
    if not isinstance(facts, list) or not isinstance(index.get("package"), str):
        raise FactReadError("not-an-index", f"{label} is not a fact index")
    return facts


def _reader_of(version: Any) -> _Reader:
    if version is None:
        return _Reader("latest")
    if version == "head" and isinstance(version, str):
        return _Reader("head")
    return _Reader("version", must_parse(version, "query version"))


def _newest_released(facts: list[Any]) -> semver.Version | None:
    newest: semver.Version | None = None
    for fact in facts:
        if not isinstance(fact, dict):
            continue
        for row in _rows_of(fact):
            if "pending" in row or "since" not in row:
                continue
            since = row["since"]
            for s in since if isinstance(since, list) else [since]:
                v = None if s == "next" else parse_version(s)
                if v is not None and (newest is None or compare_semver(v, newest) > 0):
                    newest = v
    return newest


def _removed(fact: Mapping[str, Any], reader: _Reader, latest: semver.Version | None) -> bool:
    when = fact.get("when")
    at = when.get("removeIn") if isinstance(when, dict) else None
    if not isinstance(at, str):
        return False
    if reader.kind == "head":
        return True
    if at == "next":
        return False
    gone = parse_version(at)
    if gone is None:
        return False
    current = reader.v if reader.kind == "version" else latest
    return current is not None and compare_semver(current, gone) >= 0


def select_facts(
    index: Mapping[str, Any],
    *,
    version: str | None = None,
    include: Iterable[str] = (),
    platform: str | None = None,
    os: str | None = None,
) -> list[dict[str, Any]]:
    """The facts one reader sees, from a parsed ``index.json`` of format 1.0 or 1.1.

    Each fact has rows (``variants``, or the whole fact as one row). A row applies when its ``since`` has been
    reached, its ``pending`` label is included, and its ``platforms`` and ``os`` list the reader's. Of the rows
    that apply the one with the largest bound wins, then the one with more conditions. A fact without an
    applying row, or whose ``removeIn`` has been reached, is left out. The result keeps the order of the index.
    Each returned dict is the fact with ``variants`` replaced by ``content``, ``since`` and ``stability``
    of the chosen row.
    """
    facts = assert_index(index)
    reader = _reader_of(version)
    labels = list(include)
    latest = _newest_released(facts) if reader.kind == "latest" else None
    out: list[dict[str, Any]] = []
    for fact in facts:
        if not isinstance(fact, dict) or not isinstance(fact.get("id"), str):
            continue
        row = _choose_row(_rows_of(fact), reader, labels, platform, os, fact["id"])
        if row is None or _removed(fact, reader, latest):
            continue
        selected = {k: v for k, v in fact.items() if k != "variants"}
        if "content" in row:
            selected["content"] = row["content"]
        else:
            selected.pop("content", None)
        since = row.get("since")
        selected["since"] = NO_SINCE if since is None else since
        if "stability" in row:
            selected["stability"] = row["stability"]
        out.append(selected)
    return out
