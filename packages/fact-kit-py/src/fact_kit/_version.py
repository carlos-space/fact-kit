"""Semver 2.0.0 parsing and precedence."""

from __future__ import annotations

import re
from typing import Any

import semver

from ._errors import FactReadError

_SEMVER = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?",
    re.ASCII,
)


def parse_version(text: Any) -> semver.Version | None:
    """Parse a full ``X.Y.Z`` version, or return None. Build metadata is accepted and ignored."""
    if not isinstance(text, str):
        return None
    m = _SEMVER.fullmatch(text)
    if m is None:
        return None
    return semver.Version(int(m[1]), int(m[2]), int(m[3]), m[4], m[5])


def must_parse(text: Any, what: str) -> semver.Version:
    v = parse_version(text)
    if v is None:
        raise FactReadError("invalid-version", f'{what} "{text}" is not a semver 2.0.0 version')
    return v


def compare_semver(a: semver.Version, b: semver.Version) -> int:
    return a.compare(b)


def compare_lines(a: semver.Version, b: semver.Version) -> int:
    return (a.major > b.major) - (a.major < b.major) or (a.minor > b.minor) - (a.minor < b.minor)


def compare_versions(a: str, b: str) -> int:
    """Compare two versions by semver precedence: -1, 0 or 1. Raises ``invalid-version``."""
    return compare_semver(must_parse(a, "version"), must_parse(b, "version"))


def release_line(version: str) -> str:
    """The release line ``X.Y`` of a version. ``0.49.0-alpha.1`` is on line ``0.49``."""
    v = must_parse(version, "version")
    return f"{v.major}.{v.minor}"
