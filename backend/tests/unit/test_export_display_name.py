"""A provider label revision must not block reconciliation or weaken ledger checks."""

import csv
from pathlib import Path

import pytest
from trading_max.ingestion.brokers.trading212 import (
    REQUIRED_EXPORT_COLUMNS,
    Trading212ExportSchemaError,
    merge_export_csv_files,
    reconcile_csv_files,
)


@pytest.fixture
def exports(tmp_path: Path):
    row = {
        "Action": "Market buy",
        "Time (UTC)": "2026-09-01 12:00:00",
        "ID": "synthetic-trade-1",
        "ISIN": "US0000000001",
        "Ticker": "SAMPLE",
        "Name": "Sample Fund USD (Acc)",
        "No. of shares": "2",
        "Price / share": "10",
        "Total": "20",
        "Currency (Total)": "GBP",
        "Currency (Price / share)": "GBP",
        "Exchange rate": "1",
    }

    def write(name, value):
        path = tmp_path / name
        with path.open("w", newline="") as handle:
            writer = csv.DictWriter(
                handle, fieldnames=sorted(REQUIRED_EXPORT_COLUMNS | value.keys())
            )
            writer.writeheader()
            writer.writerow(value)
        return path

    return row, write


def test_identified_trade_survives_broker_fund_display_name_revision(exports, tmp_path):
    row, write = exports
    original = write("old.csv", row)
    renamed = write("new.csv", {**row, "Name": "Sample Fund (Acc)"})
    positions = [{"instrument": {"isin": row["ISIN"], "shortName": "SAMPLE"}, "quantity": "2"}]
    assert reconcile_csv_files([original, renamed], positions).status == "verified"
    merged = merge_export_csv_files([original, renamed], tmp_path / "merged.csv")
    with merged.open() as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 1
    assert rows[0]["Name"] == "Sample Fund (Acc)"
    assert rows[0]["No. of shares"] == "2" and rows[0]["Total"] == "20"
    assert "Sample Fund USD (Acc)" in original.read_text()


@pytest.mark.parametrize(
    "column,value",
    [
        ("Action", "Market sell"),
        ("Time (UTC)", "2026-09-02 12:00:00"),
        ("ISIN", "US0000000002"),
        ("Ticker", "OTHER"),
        ("No. of shares", "3"),
        ("Total", "21"),
        ("Currency (Total)", "USD"),
        ("Currency conversion fee", "1"),
        ("Notes", "economic correction"),
        ("Unexpected field", "changed"),
    ],
)
def test_name_revision_does_not_hide_any_other_transaction_conflict(
    exports, tmp_path, column, value
):
    row, write = exports
    paths = [
        write("old.csv", row),
        write("new.csv", {**row, "Name": "Sample Fund (Acc)", column: value}),
    ]
    with pytest.raises(Trading212ExportSchemaError, match="conflicting transaction"):
        reconcile_csv_files(paths, [])
    with pytest.raises(Trading212ExportSchemaError, match="conflicting transaction"):
        merge_export_csv_files(paths, tmp_path / "merged.csv")
