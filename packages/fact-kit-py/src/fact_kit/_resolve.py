"""Find an installed ``index.json`` the way Node's ``require.resolve`` does.

Covers self-reference, the ``node_modules`` walk, symlinked packages, and ``exports`` (strings, arrays,
condition objects, nested conditions, ``*`` patterns, ``null``). ``NODE_PATH`` and the global folders are not
searched.
"""

from __future__ import annotations

import os
import re
from typing import Any

import orjson

from ._errors import FactReadError

# The conditions of `require`, in the sense of Node. Their order in `exports` is what counts, not this one.
CONDITIONS = frozenset({"node-addons", "node", "require", "module-sync", "default"})


class _InvalidTarget(Exception):
    """An `exports` target that is not allowed. An array skips it, anything else gives up."""


def split_spec(spec: str) -> tuple[str, str]:
    """Split ``@scope/name/path`` or ``name/path`` into the package name and the sub-path (``""`` if none)."""
    parts = spec.split("/")
    name_length = 2 if spec.startswith("@") else 1
    if len(parts) < name_length or any(not p for p in parts):
        raise FactReadError(
            "not-found", f'read_facts: "{spec}" is not of the form "<package>" or "<package>/<path>"'
        )
    name = "/".join(parts[:name_length])
    if name.startswith(".") or "\\" in name or "%" in name or any(p in (".", "..") for p in parts):
        raise FactReadError("not-found", f'read_facts: "{spec}" is not a valid package spec')
    return name, "/".join(parts[name_length:])


def _read_package_json(directory: str) -> dict[str, Any] | None:
    """The parsed package.json of a directory, None if there is none. Unreadable JSON is `not-found`."""
    path = os.path.join(directory, "package.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as handle:
            data = orjson.loads(handle.read())
    except (OSError, orjson.JSONDecodeError) as error:
        raise FactReadError("not-found", f"cannot read {path} ({error})") from error
    return data if isinstance(data, dict) else {}


def _not_found(message: str) -> FactReadError:
    return FactReadError("not-found", message)


_INVALID_SEGMENT = re.compile(r"(?:\.|%2e){1,2}|node_modules|%6e%6f%64%65_modules", re.IGNORECASE)


def _check_target(text: str) -> None:
    if not text.startswith("./"):
        raise _InvalidTarget(text)
    for segment in re.split(r"[\\/]", text[2:]):
        if segment and _INVALID_SEGMENT.fullmatch(segment):
            raise _InvalidTarget(text)


_UNDEFINED: Any = object()


def _resolve_target(target: Any, match: str | None) -> Any:
    """A relative path inside the package, None for `null`, or `_UNDEFINED` for no match.

    Raises `_InvalidTarget`.
    """
    if isinstance(target, str):
        _check_target(target)
        if match is None:
            return target
        for segment in re.split(r"[\\/]", match):
            if segment and _INVALID_SEGMENT.fullmatch(segment):
                raise _InvalidTarget(target)
        return target.replace("*", match)
    if isinstance(target, list):
        for item in target:
            try:
                found = _resolve_target(item, match)
            except _InvalidTarget:
                continue
            if found is not _UNDEFINED and found is not None:
                return found
        return _UNDEFINED
    if isinstance(target, dict):
        if any(k.isdigit() for k in target):
            raise _InvalidTarget("array index key")
        for key, value in target.items():
            if key in CONDITIONS:
                found = _resolve_target(value, match)
                if found is not _UNDEFINED:
                    return found
        return _UNDEFINED
    if target is None:
        return None
    raise _InvalidTarget(str(target))


def _pattern_compare(a: str, b: str) -> int:
    base_a = a.index("*") + 1 if "*" in a else len(a)
    base_b = b.index("*") + 1 if "*" in b else len(b)
    if base_a > base_b:
        return -1
    if base_b > base_a:
        return 1
    if "*" not in a:
        return 1
    if "*" not in b:
        return -1
    if len(a) > len(b):
        return -1
    if len(b) > len(a):
        return 1
    return 0


def _resolve_exports(exports: Any, subpath: str) -> Any:
    """Node's PACKAGE_EXPORTS_RESOLVE for a require. Returns a relative path, or None when nothing matches."""
    if isinstance(exports, dict):
        dotted = [k for k in exports if k.startswith(".")]
        if dotted and len(dotted) != len(exports):
            raise _InvalidTarget("exports mixes subpaths and conditions")
        if not dotted:
            exports = {".": exports}
    else:
        exports = {".": exports}
    if subpath in exports and "*" not in subpath and not subpath.endswith("/"):
        return _resolve_target(exports[subpath], None)
    best = ""
    best_match = ""
    for key in exports:
        star = key.find("*")
        if star == -1 or key.count("*") != 1 or subpath.endswith("/"):
            continue
        prefix, trailer = key[:star], key[star + 1 :]
        if (
            subpath.startswith(prefix)
            and len(subpath) >= len(key)
            and subpath.endswith(trailer)
            and _pattern_compare(best, key) == 1
        ):
            best = key
            best_match = subpath[len(prefix) : len(subpath) - len(trailer)]
    if best:
        return _resolve_target(exports[best], best_match)
    return _UNDEFINED


def _file_in(package_dir: str, relative: str) -> str:
    path = os.path.normpath(os.path.join(package_dir, relative))
    if not os.path.isfile(path):
        raise _not_found(f"{path} does not exist")
    return path


def _resolve_in_package(package_dir: str, manifest: dict[str, Any] | None, entry: str, label: str) -> str:
    subpath = f"./{entry}/index.json" if entry else "./index.json"
    exports = manifest.get("exports") if manifest else None
    if exports is None:
        return _file_in(package_dir, subpath)
    try:
        relative = _resolve_exports(exports, subpath)
    except _InvalidTarget as error:
        raise _not_found(f'{label}: "{subpath}" has an invalid export ({error})') from error
    if relative is _UNDEFINED or relative is None:
        raise _not_found(f'{label}: the package does not export "{subpath}"')
    return _file_in(package_dir, relative)


def find_index_file(spec: str, root: str) -> tuple[str, str, str]:
    """Locate ``<package>[/<path>]/index.json`` from ``root``. Returns (file, package name, entry)."""
    name, entry = split_spec(spec)
    label = f"read_facts({spec!r})"
    # 1. Self-reference: the nearest package.json, when it is this package and has `exports`.
    directory = root
    while True:
        manifest = _read_package_json(directory)
        if manifest is not None:
            if manifest.get("name") == name and manifest.get("exports") is not None:
                return _resolve_in_package(directory, manifest, entry, label), name, entry
            break
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    # 2 and 3. The nearest node_modules/<name>, following symlinks.
    directory = root
    while True:
        if os.path.basename(directory) != "node_modules":
            candidate = os.path.join(directory, "node_modules", name)
            if os.path.isdir(candidate):
                package_dir = os.path.realpath(candidate)
                manifest = _read_package_json(package_dir)
                if manifest is not None and manifest.get("exports") is not None:
                    return _resolve_in_package(package_dir, manifest, entry, label), name, entry
                # 4. Without `exports` the path is a file path. When the file is not there, Node goes on to
                # the next node_modules up.
                subpath = f"{entry}/index.json" if entry else "index.json"
                if os.path.isfile(os.path.join(package_dir, *subpath.split("/"))):
                    return _resolve_in_package(package_dir, manifest, entry, label), name, entry
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    raise _not_found(f"{label}: cannot find {name} from {root}. Install it there.")
