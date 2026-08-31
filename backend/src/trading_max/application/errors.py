"""Application-level errors shared by stages and the worker executor."""

from __future__ import annotations


class StageExecutionError(RuntimeError):
    """A stage failure with a stable code and retry classification."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        return_code: int | None = None,
    ) -> None:
        self.code = code
        self.retryable = retryable
        self.return_code = return_code
        super().__init__(message)


__all__ = ["StageExecutionError"]
