"""The error a reader raises."""

from __future__ import annotations

from typing import Final, Literal

ErrorCode = Literal["not-an-index", "unsupported-index-format", "not-found", "invalid-version"]

ERROR_CODES: Final[tuple[str, ...]] = (
    "not-an-index",
    "unsupported-index-format",
    "not-found",
    "invalid-version",
)


class FactReadError(Exception):
    """A read failed. ``code`` is stable, the message is for people and can change."""

    code: ErrorCode

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(f"{message} ({code})")
        self.code = code
