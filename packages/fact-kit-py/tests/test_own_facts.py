"""c009: the facts about this reader (fact-kit-facts/fact-kit-py) agree with the code, read through self-reference."""

from __future__ import annotations

from fact_kit import ERROR_CODES, read_facts
from helpers import facts_dir


def test_read_errors_fact_lists_the_codes_of_the_package() -> None:
    reader = read_facts("fact-kit-facts/fact-kit-py", root=facts_dir())
    codes = [c["code"] for c in reader.value("fact-kit-py.read-errors")["codes"]]
    assert sorted(codes) == sorted(ERROR_CODES)
    assert len(codes) == 4


def test_read_facts_returns_publish_and_checks_no_version(tmp_path) -> None:
    import json

    def install(publish: object) -> None:
        package = tmp_path / "node_modules" / "demo-facts"
        package.mkdir(parents=True, exist_ok=True)
        (package / "package.json").write_text(
            json.dumps({"name": "demo-facts", "version": "1.0.0", "exports": {"./index.json": "./index.json"}})
        )
        index = {"indexFormat": "1.2", "package": "demo-facts", "entry": "", "describes": {"demo-component": "0.50.0"}, "facts": []}
        if publish is not None:
            index["publish"] = publish
        (package / "index.json").write_text(json.dumps(index))
        # An installed product that is newer than describes does not matter to this reader.
        newer = tmp_path / "node_modules" / "demo"
        newer.mkdir(parents=True, exist_ok=True)
        (newer / "package.json").write_text(json.dumps({"name": "demo", "version": "9.0.0"}))

    install({"target": "npm", "name": "demo"})
    assert read_facts("demo-facts", root=tmp_path).publish == {"target": "npm", "name": "demo"}
    install(None)
    assert read_facts("demo-facts", root=tmp_path).publish is None


def test_walking_up_from_a_temporary_root_ends_with_not_found(tmp_path) -> None:
    import pytest

    from fact_kit import FactReadError

    with pytest.raises(FactReadError) as error:
        read_facts("no-such-package-facts-xyz", root=tmp_path)
    assert error.value.code == "not-found"
