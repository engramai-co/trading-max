"""Import an issuer-supported CSV containing synchronised listing prices and NAVs."""

import argparse
from pathlib import Path

from trading_max.infrastructure.durable_files import atomic_bytes
from trading_max.infrastructure.fund_premium_discount import paired_premiums, premium_file


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--isin", type=str.upper, required=True)
    parser.add_argument("--ticker", type=str.upper, required=True)
    parser.add_argument("--source-url", required=True)
    args = parser.parse_args()
    if args.csv.stat().st_size > 5_000_000:
        parser.error("CSV is too large")
    root = args.data_root.resolve()
    if not root.is_dir() or root.is_relative_to(Path(__file__).resolve().parents[1]):
        parser.error("data root must be an existing directory outside the checkout")
    output = premium_file(root, args.isin, args.ticker)
    if output is None:
        parser.error("no verified issuer listing for this share class")
    data = paired_premiums(args.isin, args.ticker, args.source_url, args.csv.read_text())
    atomic_bytes(output, data.model_dump_json().encode())
    print(f"{data.ticker}: {len(data.points)} same-time premium observations")


if __name__ == "__main__":
    main()
