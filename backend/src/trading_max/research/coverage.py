"""Per-security research freshness, independent of whole-artifact publication."""

from __future__ import annotations

from typing import Any

from .facts import fingerprint


def row_identity(row: dict[str, Any]) -> str:
    return str(row.get("ticker") or row.get("t") or "").upper()


def row_clocks(payload: dict[str, Any], *, generated_at: str | None = None) -> dict[str, dict]:
    existing = payload.get("rowClocks") or {}
    result = {
        ticker: {
            "state": "missing",
            "reason": reason,
            "lastAttemptAt": payload.get("generated_at") or generated_at,
        }
        for ticker, reason in (payload.get("missing") or {}).items()
    }
    for row in payload.get("rows") or []:
        ticker = row_identity(row)
        if not ticker:
            continue
        result[ticker] = {
            "state": "available",
            "asOf": row.get("asOf")
            or row.get("as_of")
            or payload.get("as_of")
            or payload.get("asOf"),
            "fetchedAt": payload.get("generated_at") or generated_at,
            "lastSuccessfulAt": payload.get("generated_at") or generated_at,
            "version": fingerprint(row),
        }
    return {**result, **existing}


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
    previous_clocks = row_clocks(previous)
    fresh_clocks = row_clocks(payload)
    clocks = {**previous_clocks, **fresh_clocks}
    attempted = {s.upper() for s in refreshed}
    for ticker in attempted - new.keys():
        fresh = fresh_clocks.get(ticker, {})
        reason = fresh.get("reason") if fresh.get("state") == "missing" else None
        reason = reason or "refresh-failed"
        retained = ticker in old
        clocks[ticker] = {
            **(previous_clocks.get(ticker, {}) if retained else {}),
            "state": "stale" if retained else "missing",
            "reason": f"{reason}-retained" if retained else reason,
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
