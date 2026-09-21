from trading_max.backup import _included_files


def test_only_versioned_derived_history_namespace_is_excluded(tmp_path):
    for name in (
        "runtime/history-query-cache-v1/index.sqlite3",
        "runtime/account-ledger.sqlite3",
        "runtime/other-cache/unknown.json",
        "artifacts/financial-evidence.json",
    ):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic")
    assert {p.relative_to(tmp_path).as_posix() for p in _included_files(tmp_path)} == {
        "runtime/account-ledger.sqlite3",
        "runtime/other-cache/unknown.json",
        "artifacts/financial-evidence.json",
    }
