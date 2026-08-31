"""Structured JSON logging for the Trading Max API.

Logs are emitted as one JSON object per line so they can be filtered with
`jq` without a log aggregator. A rotating file handler bounds disk usage;
LaunchAgents redirect stdout/stderr to their own files, so the rotating
handler owns the durable, queryable copy.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
from datetime import UTC, datetime
from pathlib import Path

SERVICE_NAME = "trading-max-api"

_RESERVED = {
    "args",
    "asctime",
    "created",
    "exc_info",
    "exc_text",
    "filename",
    "funcName",
    "levelname",
    "levelno",
    "lineno",
    "module",
    "msecs",
    "message",
    "msg",
    "name",
    "pathname",
    "process",
    "processName",
    "relativeCreated",
    "stack_info",
    "thread",
    "threadName",
    "taskName",
}


class JsonFormatter(logging.Formatter):
    """Render records as single-line JSON with structured extras preserved."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "service": SERVICE_NAME,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            try:
                json.dumps(value)
            except (TypeError, ValueError):
                value = repr(value)
            payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def default_log_directory() -> Path:
    configured = os.environ.get("TRADING_MAX_LOG_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "Library" / "Logs" / "Trading Max"


def configure_logging(
    *,
    level: str | None = None,
    log_directory: Path | None = None,
    max_bytes: int = 16 * 1024 * 1024,
    backup_count: int = 5,
) -> logging.Logger:
    """Install the JSON console handler plus a size-bounded rotating file."""
    resolved_level = (level or os.environ.get("TRADING_MAX_LOG_LEVEL") or "INFO").upper()
    root = logging.getLogger()
    root.setLevel(resolved_level)

    for handler in list(root.handlers):
        if getattr(handler, "_trading_max_managed", False):
            root.removeHandler(handler)

    formatter = JsonFormatter()

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console._trading_max_managed = True  # type: ignore[attr-defined]
    root.addHandler(console)

    directory = log_directory or default_log_directory()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        rotating = logging.handlers.RotatingFileHandler(
            directory / "trading-max-api.jsonl",
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        rotating.setFormatter(formatter)
        rotating._trading_max_managed = True  # type: ignore[attr-defined]
        root.addHandler(rotating)
    except OSError:
        root.warning(
            "rotating log handler unavailable",
            extra={"directory": str(directory)},
        )

    # uvicorn installs its own handlers; route them through ours instead.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True

    return logging.getLogger(SERVICE_NAME)
