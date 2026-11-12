"""Validate the same portable seed consumed by the packaged desktop runtime."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from itertools import pairwise
from pathlib import Path
from zoneinfo import ZoneInfo

from services.api.trading_max_api.artifacts import ArtifactStore

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_seed.py"
LONDON = ZoneInfo("Europe/London")


class PackagedSeedTests(unittest.TestCase):
    def test_weekday_valuations_cover_midnight_and_keep_the_latest_london_close(self):
        with tempfile.TemporaryDirectory() as temporary:
            seed = Path(temporary) / "seed"
            subprocess.run(  # noqa: S603 -- fixed interpreter and checked-in seed generator
                [sys.executable, str(SCRIPT), str(seed), "--as-of", "2026-04-10"],
                check=True,
                capture_output=True,
                text=True,
            )
            store = ArtifactStore(seed)
            refs = {ref.key: ref for ref in store.immutable_snapshots.latest().manifest.artifacts}
            ref = refs["account/nav/valuation_history.json"]
            history = store.immutable_artifacts.get_json(ref.artifact_id).payload
            flows = store.immutable_artifacts.get_json(
                refs["account/nav/cash_flows_a.json"].artifact_id
            ).payload

        by_day = defaultdict(list)
        for point in history["points"]:
            stamp = datetime.fromisoformat(point["observed_at"])
            self.assertEqual(stamp.utcoffset(), timedelta(0))
            self.assertEqual(point["observed_at"], point["bucket_at"])
            local = stamp.astimezone(LONDON)
            self.assertLess(local.weekday(), 5)
            by_day[local.date()].append((stamp, point))

        for day, entries in by_day.items():
            first, last = entries[0][0], entries[-1][0]
            cadence = 600 if (date(2026, 4, 10) - day).days < 21 else 3600
            self.assertEqual(first.astimezone(LONDON).time(), time.min)
            self.assertEqual(
                last.astimezone(LONDON).time(),
                time(20) if day == date(2026, 4, 10) else time(23, 50 if cadence == 600 else 0),
            )
            self.assertTrue(all(point["cadence_seconds"] == cadence for _, point in entries))
            self.assertTrue(
                all((b[0] - a[0]).total_seconds() == cadence for a, b in pairwise(entries))
            )

        friday = by_day[date(2026, 3, 27)]
        monday = by_day[date(2026, 3, 30)]
        self.assertEqual(friday[0][0], datetime(2026, 3, 27, tzinfo=UTC))
        self.assertEqual(monday[0][0], datetime(2026, 3, 29, 23, tzinfo=UTC))
        self.assertEqual(monday[0][1]["total_value_gbp"], friday[-1][1]["total_value_gbp"])
        close = datetime(2026, 4, 10, 19, tzinfo=UTC).isoformat()
        self.assertEqual(history["points"][-1]["observed_at"], close)
        self.assertEqual(history["generated_at"], close)
        self.assertEqual(flows["covered_until"], close)
        self.assertEqual(flows["events"][0]["accounting_date"], min(by_day).isoformat())
