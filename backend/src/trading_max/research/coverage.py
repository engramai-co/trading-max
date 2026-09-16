"""Per-security research freshness, independent of whole-artifact publication."""

from __future__ import annotations

from typing import Any

from .facts import fingerprint


def row_identity(row: dict[str, Any]) -> str:
    return str(row.get("ticker") or row.get("t") or "").upper()


def row_clocks(payload: dict[str, Any], *, generated_at: str | None = None) -> dict[str, dict]:
    existing = payload.get("rowClocks") or {}
    result = {}
    for row in payload.get("rows") or []:
        ticker = row_identity(row)
        if not ticker:
            continue
        clock = existing.get(ticker)
        result[ticker] = clock or {
            "state": "available",
            "asOf": row.get("asOf")
            or row.get("as_of")
            or payload.get("as_of")
            or payload.get("asOf"),
            "fetchedAt": payload.get("generated_at") or generated_at,
            "lastSuccessfulAt": payload.get("generated_at") or generated_at,
            "version": fingerprint(row),
        }
    return result


def merge_rows(
    previous: dict[str, Any], payload: dict[str, Any], refreshed: tuple[str, ...]
) -> dict:
    """Missing results are failures, never deletion of last successful data.

    An explicit empty row is still a successful observation (e.g. no options).
    Only requested symbols are marked failed; untouched symbols keep their clock.
    """
    old_rows, new_rows = previous.get("rows"), payload.get("rows")
    if not isinstance(old_rows, list) or not isinstance(new_rows, list):
        return payload
    old = {row_identity(r): r for r in old_rows if isinstance(r, dict)}
    new = {row_identity(r): r for r in new_rows if isinstance(r, dict)}
    clocks = row_clocks(previous)
    clocks.update(row_clocks(payload))
    attempted = {s.upper() for s in refreshed}
    for ticker in attempted - new.keys():
        clocks[ticker] = {
            **clocks.get(ticker, {}),
            "state": "stale" if ticker in old else "missing",
            "reason": "refresh-failed-retained" if ticker in old else "refresh-failed",
            "lastAttemptAt": payload.get("generated_at"),
        }
    return {
        **payload,
        "rows": [*([r for ticker, r in old.items() if ticker not in new]), *new.values()],
        "tickers": list(
            dict.fromkeys(
                [*(previous.get("tickers") or old.keys()), *(payload.get("tickers") or new.keys())]
            )
        ),
        "rowClocks": clocks,
    }
