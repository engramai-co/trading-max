import pytest

from tools.release_contract import (
    ROOT,
    ReleaseContractError,
    extract_release_notes,
    find_changelog_release,
    project_versions,
    validate_initial_version,
    validate_project_versions,
    validate_version_increment,
)


def test_public_release_baseline_is_exactly_one_zero_zero() -> None:
    validate_initial_version("1.0.0")
    with pytest.raises(ReleaseContractError):
        validate_initial_version("0.1.0")


@pytest.mark.parametrize(
    ("base", "head"),
    [("1.2.0", "1.2.1"), ("1.2.9", "1.3.0"), ("1.9.9", "2.0.0")],
)
def test_accepts_one_conventional_semver_increment(base: str, head: str) -> None:
    validate_version_increment(base, head)


@pytest.mark.parametrize(
    ("base", "head"),
    [("1.2.0", "1.2.0"), ("1.2.0", "1.2.2"), ("1.2.0", "1.3.1"), ("1.2.0", "2.1.0")],
)
def test_rejects_missing_or_skipped_semver_increments(base: str, head: str) -> None:
    with pytest.raises(ReleaseContractError):
        validate_version_increment(base, head)


def test_requires_the_top_formal_changelog_release_to_match() -> None:
    text = """# Changelog

## [Unreleased]

## [1.2.1] - 2026-09-01

### Fixed

- Preserve visible evidence gaps.

## [1.2.0] - 2026-08-30
"""

    release = find_changelog_release(text, "1.2.1")

    assert release.released_on == "2026-09-01"
    assert extract_release_notes(text, "1.2.1") == (
        "### Fixed\n\n- Preserve visible evidence gaps.\n"
    )


def test_rejects_an_empty_or_uncategorized_changelog_release() -> None:
    with pytest.raises(ReleaseContractError):
        find_changelog_release(
            "# Changelog\n\n## [1.2.1] - 2026-09-01\n\n- Missing category.\n",
            "1.2.1",
        )


def test_repository_version_surfaces_match_version_file() -> None:
    expected = (ROOT / "VERSION").read_text(encoding="utf-8").strip()

    versions = validate_project_versions(expected)

    assert len(versions) >= 10
    assert set(project_versions().values()) == {expected}


def test_auto_release_waits_for_protected_main_checks_and_dispatches_full_release() -> None:
    workflow = (ROOT / ".github" / "workflows" / "auto-release.yml").read_text(encoding="utf-8")

    assert "branches: [main]" in workflow
    assert "Wait for protected main checks" in workflow
    assert '"Backend (pytest)"' in workflow
    assert '"Secret and artifact scan"' in workflow
    assert "ref: ${{ github.sha }}" in workflow
    assert "workflow_run" not in workflow
    assert "no prior SemVer tag is reachable" not in workflow
    assert "python tools/check_version_bump.py --initial" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "gh workflow run release.yml" in workflow


def test_release_actions_are_pinned_to_full_commit_shas() -> None:
    workflow_paths = (
        ROOT / ".github" / "workflows" / "release-contract.yml",
        ROOT / ".github" / "workflows" / "auto-release.yml",
    )
    for workflow_path in workflow_paths:
        for line in workflow_path.read_text(encoding="utf-8").splitlines():
            if "uses:" not in line:
                continue
            reference = line.split("@", maxsplit=1)[-1].split()[0]
            assert len(reference) == 40
            assert all(character in "0123456789abcdef" for character in reference)
