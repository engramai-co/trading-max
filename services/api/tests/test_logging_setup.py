from __future__ import annotations

import json
import logging
from pathlib import Path

from services.api.trading_max_api.logging_setup import (
    JsonFormatter,
    configure_logging,
)


def _record(**extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="trading_max-api",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="request completed",
        args=(),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_formatter_emits_single_line_json_with_extras() -> None:
    rendered = JsonFormatter().format(_record(request_id="abc123", status=200, duration_ms=12.5))

    assert "\n" not in rendered
    payload = json.loads(rendered)
    assert payload["message"] == "request completed"
    assert payload["level"] == "INFO"
    assert payload["service"] == "trading-max-api"
    assert payload["request_id"] == "abc123"
    assert payload["status"] == 200
    assert payload["duration_ms"] == 12.5
    assert "timestamp" in payload


def test_formatter_survives_unserialisable_extras() -> None:
    payload = json.loads(JsonFormatter().format(_record(obj=object())))
    assert isinstance(payload["obj"], str)


def test_configure_logging_writes_rotating_jsonl(tmp_path: Path) -> None:
    logger = configure_logging(level="INFO", log_directory=tmp_path)
    logger.info("hello", extra={"request_id": "r-1"})

    for handler in logging.getLogger().handlers:
        handler.flush()

    log_file = tmp_path / "trading-max-api.jsonl"
    assert log_file.is_file()

    lines = [line for line in log_file.read_text(encoding="utf-8").splitlines() if line]
    payload = json.loads(lines[-1])
    assert payload["message"] == "hello"
    assert payload["request_id"] == "r-1"


def test_configure_logging_is_idempotent(tmp_path: Path) -> None:
    configure_logging(level="INFO", log_directory=tmp_path)
    first = len(logging.getLogger().handlers)
    configure_logging(level="INFO", log_directory=tmp_path)
    assert len(logging.getLogger().handlers) == first
