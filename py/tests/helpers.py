"""Where the shared samples and the facts live, and a JS-like deep equality."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent


def _walk_up(env: str, found) -> Path:
    value = os.environ.get(env)
    if value:
        return Path(value).resolve()
    for directory in [HERE, *HERE.parents]:
        for name in found:
            candidate = directory / name
            if candidate.is_dir():
                return candidate
    raise RuntimeError(f"cannot find the directory: set {env}")


def conformance_dir() -> Path:
    """``$FACT_KIT_CONFORMANCE``, else the nearest ``conformance/`` above this file."""
    return _walk_up("FACT_KIT_CONFORMANCE", ["conformance"])


def facts_dir() -> Path:
    """``$FACT_KIT_FACTS``, else the nearest ``facts/`` above this file."""
    return _walk_up("FACT_KIT_FACTS", ["facts"])


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def case_dirs(name: str) -> list[str]:
    return sorted(p.name for p in (conformance_dir() / name).iterdir() if p.is_dir())


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
