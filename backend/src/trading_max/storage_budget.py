"""Account for the whole installation and bound disposable cache growth.

Financial records are never evicted. The report uses allocated bytes as well as
file lengths, deduplicates hard links, and never follows directory symlinks.
"""

from __future__ import annotations

import json
import os
import re
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .backup_repository import atomic_json

DEFAULT_BUDGET_BYTES = 5_000_000_000
DEFAULT_CACHE_BYTES = 250_000_000
_CACHE_NAME = re.compile(r"[0-9a-f]{64}(?:\.parsed)?\.(?:json|html)")


def configured_budget() -> int:
    budget = int(os.environ.get("TRADING_MAX_STORAGE_BUDGET_BYTES", str(DEFAULT_BUDGET_BYTES)))
    if budget < 100_000_000:
        raise ValueError("storage budget must be at least 100 MB")
    return budget


def usage(roots: dict[str, Path]) -> dict:
    seen = set()
    rows = {}
    for category, root in roots.items():
        result = {"fileBytes": 0, "allocatedBytes": 0, "files": 0}
        if root.is_symlink():
            raise ValueError("inventory root must not be a symlink")
        if not root.exists():
            rows[category] = result
            continue
        for directory, subdirectories, names in os.walk(root, followlinks=False):
            subdirectories[:] = [
                name for name in subdirectories if not (Path(directory) / name).is_symlink()
            ]
            for name in names:
                path = Path(directory) / name
                try:
                    info = path.lstat()
                except FileNotFoundError:
                    continue  # Concurrent atomic publication; the next census observes it.
                if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) in seen:
                    continue
                seen.add((info.st_dev, info.st_ino))
                result["fileBytes"] += info.st_size
                result["allocatedBytes"] += (
                    getattr(info, "st_blocks", (info.st_size + 511) // 512) * 512
                )
                result["files"] += 1
        rows[category] = result
    return {
        "categories": rows,
        **{
            key: sum(row[key] for row in rows.values())
            for key in ("fileBytes", "allocatedBytes", "files")
        },
    }


def installation_roots(service: Path, state: Path, logs: Path, legacy: Path) -> dict[str, Path]:
    # More specific roots precede their parent. The inode set prevents counting
    # releases/backups a second time in serviceOther without omitting other files.
    return {
        "businessState": state,
        "backups": service / "backups",
        "runtimes": service / "releases",
        "serviceOther": service,
        "logs": logs,
        "legacyBackups": legacy,
    }


def write_budget_report(
    service: Path,
    state: Path,
    logs: Path,
    legacy: Path,
    *,
    budget: int | None = None,
    now: datetime | None = None,
) -> dict:
    now = now or datetime.now(UTC)
    limit = configured_budget() if budget is None else budget
    if limit <= 0:
        raise ValueError("storage budget must be positive")
    report = usage(installation_roots(service, state, logs, legacy))
    used = max(report["fileBytes"], report["allocatedBytes"])
    directory = service / "maintenance/storage-budget"
    history_path = directory / "history.json"
    previous = (
        json.loads(history_path.read_text()).get("days", []) if history_path.is_file() else []
    )
    previous = [day for day in previous if day["date"] != now.date().isoformat()][-89:]
    growth = None
    baseline = next(
        (
            day
            for day in reversed(previous)
            if datetime.fromisoformat(day["date"]).date() <= (now - timedelta(days=7)).date()
        ),
        None,
    )
    if baseline:
        days = (now.date() - datetime.fromisoformat(baseline["date"]).date()).days
        growth = max(0, (used - baseline["usedBytes"]) / days)
    report.update(
        schemaVersion=1,
        measuredAt=now.isoformat(),
        budgetBytes=limit,
        usedBytes=used,
        remainingBytes=max(0, limit - used),
        dailyGrowthBytes=growth,
        projectedDaysRemaining=(max(0, limit - used) / growth if growth else None),
        status="over-budget"
        if used > limit
        else "critical"
        if used >= limit * 0.9
        else "warning"
        if used >= limit * 0.8
        else "watch"
        if used >= limit * 0.7
        else "ok",
        policy="Unique financial observations are retained; only disposable caches and verified obsolete recovery/runtime copies may be retired.",
    )
    previous.append({"date": now.date().isoformat(), "usedBytes": used})
    atomic_json(history_path, {"schemaVersion": 1, "days": previous})
    atomic_json(directory / "latest.json", report)
    atomic_json(state / "runtime/storage-budget.json", report)
    return report


def bound_filing_cache(
    state: Path,
    *,
    budget: int = DEFAULT_CACHE_BYTES,
    now: datetime | None = None,
    max_files=256,
    max_bytes=128 * 1024 * 1024,
) -> dict:
    if min(budget, max_files, max_bytes) <= 0:
        raise ValueError("cache budgets must be positive")
    now = now or datetime.now(UTC)
    root = state / "research-cache/disclosures"
    if root.is_symlink():
        raise ValueError("cache root must not be a symlink")
    files = []
    if root.exists():
        for path in root.iterdir():
            if path.is_symlink():
                raise ValueError("cache entries must not be symlinks")
            if path.is_file() and _CACHE_NAME.fullmatch(path.name):
                info = path.stat()
                files.append((info.st_mtime_ns, path, info))
    total = sum(max(info.st_size, getattr(info, "st_blocks", 0) * 512) for _, _, info in files)
    removed = freed = 0
    cutoff = (now - timedelta(days=1)).timestamp()
    for _, path, info in sorted(files):
        size = max(info.st_size, getattr(info, "st_blocks", 0) * 512)
        if total <= budget or removed >= max_files:
            break
        if info.st_mtime >= cutoff or freed + size > max_bytes:
            continue
        current = path.stat()
        if (current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (
            info.st_ino,
            info.st_size,
            info.st_mtime_ns,
            info.st_ctime_ns,
        ):
            continue
        # These are publicly retrievable URL-keyed filing documents or derived
        # parser/results caches. Broker source artifacts and snapshots are excluded.
        path.unlink()
        removed += 1
        freed += size
        total -= size
    return {
        "removedFiles": removed,
        "freedBytes": freed,
        "remainingBytes": total,
        "budgetBytes": budget,
        "pending": total > budget,
    }


def nightly_storage(
    service: Path, state: Path, *, logs: Path | None = None, legacy: Path | None = None
) -> dict:
    cache = bound_filing_cache(state)
    report = write_budget_report(
        service,
        state,
        logs or Path.home() / "Library/Logs/Trading Max",
        legacy or Path.home() / "Backups/Trading Max",
    )
    return {"cache": cache, "budget": report}
