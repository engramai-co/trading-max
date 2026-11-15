"""Import a locally downloaded issuer workbook into a private workspace."""

import argparse
from datetime import UTC, datetime
from pathlib import Path

from trading_max.infrastructure.durable_files import atomic_bytes
from trading_max.infrastructure.fund_tracking_import import (
    download_url,
    import_issuer_tracking,
    issuer_portfolio_valuation,
)
from trading_max.infrastructure.index_valuation_archive import archive_valuation


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--isin", required=True, type=str.upper)
    parser.add_argument("--data-root", type=Path)
    parser.add_argument("--workbook", type=Path)
    parser.add_argument("--source-url", action="store_true", help="Show the issuer's download URL")
    args = parser.parse_args()
    if args.source_url:
        if url := download_url(args.isin):
            print(url)
            return
        parser.error("no verified issuer workbook for this share class")
    if not args.workbook or not args.data_root or not args.data_root.is_dir():
        parser.error("supply an existing external --data-root and a --workbook")
    if args.workbook.stat().st_size > 15_000_000:
        parser.error("workbook is too large")
    data_root = args.data_root.resolve()
    checkout = Path(__file__).resolve().parents[1]
    if data_root.is_relative_to(checkout):
        parser.error("data root must be outside the checkout")
    data = args.workbook.read_bytes()
    result = import_issuer_tracking(args.isin, data)
    path = data_root / "reference" / "fund-tracking" / (result.isin + ".json")
    atomic_bytes(path, result.model_dump_json().encode())
    if valuation := issuer_portfolio_valuation(result, data, datetime.now(UTC)):
        archive_valuation(data_root / "state" / "indices" / "valuation-v1", valuation)
    print(f"{result.isin}: {result.state}; {len(result.points)} dated observations")


if __name__ == "__main__":
    main()
