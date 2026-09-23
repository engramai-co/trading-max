from __future__ import annotations

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest
from trading_max.backup_repository import exclusive_lock

SCRIPT = Path(__file__).resolve().parents[3] / "tools/manage_backups.py"
spec = importlib.util.spec_from_file_location("manage_backups", SCRIPT)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def arguments(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as connection:
        connection.execute("CREATE TABLE synthetic(value TEXT)")
    return [
        str(SCRIPT),
        "--repository",
        str(tmp_path / "backups"),
        "create",
        "--state-root",
        str(state),
    ]


def test_cli_keeps_final_json_on_stdout_and_reports_phases_on_stderr(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", arguments(tmp_path))
    assert cli.main() == 0
    captured = capsys.readouterr()
    result = json.loads(captured.out)
    events = [json.loads(line) for line in captured.err.splitlines()]
    assert [event["phase"] for event in events] == ["capturing", "verifying", "backup-published"]
    assert events[-1]["backupId"] == result["id"]


def test_cli_deadline_fails_before_publication_and_releases_lock(tmp_path, monkeypatch):
    args = arguments(tmp_path)
    args[1:1] = ["--max-seconds", "0.000000001"]
    monkeypatch.setattr("sys.argv", args)
    with pytest.raises(TimeoutError, match="time budget"):
        cli.main()
    assert not list((tmp_path / "backups/snapshots").iterdir())
    with exclusive_lock(tmp_path / "backups/.repository.lock"):
        pass


@pytest.mark.parametrize("maximum", ["0", "-1", "nan", "inf"])
def test_cli_rejects_invalid_deadlines(tmp_path, monkeypatch, maximum):
    args = arguments(tmp_path)
    args[1:1] = ["--max-seconds", maximum]
    monkeypatch.setattr("sys.argv", args)
    with pytest.raises(SystemExit):
        cli.main()
    assert not (tmp_path / "backups").exists()
