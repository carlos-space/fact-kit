"""c009: the facts about this reader (fact-kit-facts/py) agree with the code, read through self-reference."""

from __future__ import annotations

from fact_kit import ERROR_CODES, read_facts
from helpers import facts_dir


def test_read_errors_fact_lists_the_codes_of_the_package() -> None:
    reader = read_facts("fact-kit-facts/py", root=facts_dir(), version="head", include=["readers"])
    codes = [c["code"] for c in reader.value("fact-kit-py.read-errors")["codes"]]
    assert sorted(codes) == sorted(ERROR_CODES)
    assert len(codes) == 4
