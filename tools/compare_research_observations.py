"""Compare an external research ledger without importing live data into Git.

Input is a JSON list of {left: ComparisonSample, right: ComparisonSample} pairs.
Output retains both samples and lists the reasons a numeric comparison is unsafe.
"""

import argparse
import json
from pathlib import Path

from trading_max.research.comparability import ComparisonSample, compare_samples


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=Path)
    args = parser.parse_args()
    pairs = json.loads(args.ledger.read_text())
    print(
        json.dumps(
            [
                compare_samples(
                    ComparisonSample.model_validate(p["left"]),
                    ComparisonSample.model_validate(p["right"]),
                ).model_dump(mode="json")
                for p in pairs
            ],
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
