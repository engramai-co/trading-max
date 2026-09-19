"""Run release workflow shell decisions with synthetic GitHub responses."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def step_script(workflow: str, name: str) -> str:
    lines = (ROOT / ".github/workflows" / workflow).read_text().splitlines()
    start = lines.index(f"      - name: {name}")
    run = next(i for i in range(start, len(lines)) if lines[i] == "        run: |") + 1
    end = next(
        (i for i in range(run, len(lines)) if lines[i] and not lines[i].startswith("          ")),
        len(lines),
    )
    return "\n".join(line[10:] for line in lines[run:end])


@pytest.mark.parametrize("operations", ["success", "skipped", "failure"])
def test_auto_release_requires_the_operational_check_to_finish(tmp_path: Path, operations: str):
    if shutil.which("jq") is None:
        pytest.skip("jq is required to exercise the GitHub workflow script")
    results = {
        "Backend (pytest)": "success",
        "Frontend (lint, types, tests, build)": "success",
        "Secret and artifact scan": "success",
        "Dependency audit": "success",
        "Migration and deployment contracts": operations,
    }
    payload = tmp_path / "checks.json"
    payload.write_text(
        json.dumps({"check_runs": [{"name": k, "conclusion": v} for k, v in results.items()]})
    )
    binary = tmp_path / "gh"
    binary.write_text('#!/bin/sh\nexec cat "$SYNTHETIC_CHECK_RUNS"\n')
    binary.chmod(0o700)
    result = subprocess.run(
        ["/bin/bash", "-c", step_script("auto-release.yml", "Wait for protected main checks")],
        env={
            **os.environ,
            "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
            "SYNTHETIC_CHECK_RUNS": str(payload),
            "GITHUB_REPOSITORY": "fixture/repository",
            "COMMIT_SHA": "a" * 40,
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == (1 if operations == "failure" else 0), result.stderr
    if operations == "failure":
        assert "required check failed: Migration and deployment contracts" in result.stdout


@pytest.mark.parametrize("tag", ["v1.2.3", "main", "v01.2.3", "v1.2.3$(touch injected)"])
def test_release_tag_is_validated_as_data_before_checkout(tmp_path: Path, tag: str):
    output = tmp_path / "output"
    result = subprocess.run(
        ["/bin/bash", "-c", step_script("release.yml", "Resolve release tag")],
        cwd=tmp_path,
        env={
            **os.environ,
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "REQUESTED_TAG": tag,
            "GITHUB_OUTPUT": str(output),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == (0 if tag == "v1.2.3" else 1), result.stderr
    assert not (tmp_path / "injected").exists()
    if result.returncode == 0:
        assert output.read_text() == f"value={tag}\n"
