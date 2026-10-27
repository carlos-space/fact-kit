"""``read_facts``: find an installed fact package, parse its index and select the facts of one reader."""

from __future__ import annotations

import os as _os
from collections.abc import Iterable
from typing import Any

import orjson

from ._errors import FactReadError
from ._resolve import find_index_file
from ._select import assert_index, select_facts


def _owning_version(file: str, name: str) -> str:
    """The ``package.json`` version of the package ``name`` that contains ``file``."""
    directory = _os.path.dirname(file)
    while True:
        manifest = _os.path.join(directory, "package.json")
        if _os.path.isfile(manifest):
            try:
                with open(manifest, "rb") as handle:
                    data = orjson.loads(handle.read())
            except (OSError, orjson.JSONDecodeError):
                data = None
            if isinstance(data, dict) and data.get("name") == name:
                version = data.get("version")
                return version if isinstance(version, str) else ""
        parent = _os.path.dirname(directory)
        if parent == directory:
            return ""
        directory = parent


class FactReader:
    """The facts one reader sees, from one installed ``index.json``."""

    def __init__(
        self,
        *,
        package: str,
        version: str,
        entry: str,
        describes: dict[str, str],
        facts: list[dict[str, Any]],
    ) -> None:
        self.package = package
        """Name of the fact package, from the index."""
        self.version = version
        """Version of the installed fact package, from its ``package.json``."""
        self.entry = entry
        """Sub-path of the entry inside the package."""
        self.describes = describes
        """The component this entry describes and the version it covers."""
        self.facts = facts
        """The facts this reader sees, each flattened to the row that applies."""
        self._by_id = {f["id"]: f for f in facts}

    def has(self, id: str) -> bool:
        """Whether a fact with this id exists."""
        return id in self._by_id

    def get(self, id: str) -> dict[str, Any]:
        """The fact with this id. Raises ``KeyError`` when there is none, so a typo fails loudly."""
        try:
            return self._by_id[id]
        except KeyError:
            raise KeyError(f'read_facts: no fact "{id}" in {self.package}') from None

    def value(self, id: str) -> Any:
        """The ``content["value"]`` of the fact with this id. Raises ``ValueError`` without value content."""
        content = self.get(id).get("content")
        if not isinstance(content, dict) or "value" not in content:
            raise ValueError(f'read_facts: fact "{id}" in {self.package} has no value content')
        return content["value"]


def read_facts(
    spec: str,
    *,
    root: str | _os.PathLike[str] | None = None,
    version: str | None = None,
    include: Iterable[str] = (),
    platform: str | None = None,
    os: str | None = None,
) -> FactReader:
    """Read the built ``index.json`` of ``<package>`` or ``<package>/<path>`` as installed under ``root``.

    The package is found the way Node's ``require.resolve`` finds it from ``root`` (default: the current
    directory) and must export ``./index.json`` or ``./<path>/index.json``. The index may be format 1.0 or 1.1.
    ``version``, ``include``, ``platform`` and ``os`` choose what the reader sees, see :func:`select_facts`.
    Raises :class:`FactReadError`.
    """
    base = _os.getcwd() if root is None else _os.fspath(root)
    base = _os.path.abspath(base)
    file, package_name, entry = find_index_file(spec, base)
    try:
        with open(file, "rb") as handle:
            index = orjson.loads(handle.read())
    except (OSError, orjson.JSONDecodeError) as error:
        raise FactReadError("not-an-index", f"read_facts: {file} is not a fact index ({error})") from error
    assert_index(index, f"read_facts: {file}")
    facts = select_facts(index, version=version, include=include, platform=platform, os=os)
    describes = index.get("describes")
    entry_name = index.get("entry")
    return FactReader(
        package=index["package"],
        version=_owning_version(file, package_name),
        entry=entry_name if isinstance(entry_name, str) else entry,
        describes=describes if isinstance(describes, dict) else {},
        facts=facts,
    )
