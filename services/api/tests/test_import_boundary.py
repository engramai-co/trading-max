from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_typed_worker_import_does_not_load_legacy_execution_modules(
    tmp_path: Path,
) -> None:
    code = """
import sys
import services.api.trading_max_api.worker_main

legacy = {
    'services.api.trading_max_api.analysis',
    'services.api.trading_max_api.jobs',
    'services.api.trading_max_api.pipeline',
    'services.api.trading_max_api.durable_jobs',
    'services.api.trading_max_api.worker_bridge',
}
if legacy.intersection(sys.modules):
    raise SystemExit('legacy execution module loaded')
"""
    env = os.environ.copy()
    env.update(
        {
            "TRADING_MAX_ENV": "production",
            "TRADING_MAX_DATA_ROOT": str(tmp_path / "state"),
            "TRADING_MAX_API_TOKEN": "test-token",
            "PYTHONPATH": os.pathsep.join((str(ROOT), str(ROOT / "backend" / "src"))),
        }
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr or result.stdout
