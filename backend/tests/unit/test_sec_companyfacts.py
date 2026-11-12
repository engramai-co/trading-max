from datetime import date

from trading_max.research import sec_companyfacts


def test_companyfacts_resolves_ticker_and_joins_archived_acceptances_without_date_fallback(
    tmp_path, monkeypatch
):
    cik = "CIK0000000001"
    amended, untimed, original = (
        "0000000001-24-000002",
        "0000000001-24-000003",
        "0000000001-24-000001",
    )
    archive = cik + "-submissions-001.json"

    def submissions(accessions, times, forms):
        return {
            "accessionNumber": accessions,
            "acceptanceDateTime": times,
            "form": forms,
            "reportDate": ["2023-12-31"] * len(accessions),
        }

    def fact(accession, value, form):
        return {
            "accn": accession,
            "start": "2023-01-01",
            "end": "2023-12-31",
            "filed": "2024-03-01",
            "form": form,
            "val": value,
        }

    def get(url):
        visited.append(url)
        return {
            sec_companyfacts.TICKER_MAP: {"0": {"ticker": "SYNT", "cik_str": 1}},
            f"https://data.sec.gov/submissions/{cik}.json": {
                "tickers": ["SYNT"],
                "filings": {
                    "recent": submissions(
                        [amended, untimed],
                        ["2024-02-29T19:00:00.000Z", "2024-03-01"],
                        ["10-K/A", "10-K/A"],
                    ),
                    "files": [{"name": archive, "filingTo": "2024-02-01"}],
                },
            },
            f"https://data.sec.gov/submissions/{archive}": submissions(
                [original],
                ["2024-02-01T23:00:00Z"],
                ["10-K"],
            ),
            f"https://data.sec.gov/api/xbrl/companyfacts/{cik}.json": {
                "cik": 1,
                "facts": {
                    "us-gaap": {
                        "EarningsPerShareDiluted": {
                            "units": {
                                "USD/shares": [
                                    fact(amended, 7.5, "10-K/A"),
                                    fact(untimed, 1, "10-K/A"),
                                    fact(original, 8, "10-K"),
                                ]
                            }
                        }
                    }
                },
            },
        }[url]

    visited = []
    monkeypatch.setattr(sec_companyfacts, "_get_json", get)
    provider = sec_companyfacts.SecCompanyFacts(tmp_path)
    filings = sorted(provider.filings("SYNT", since=date(2024, 1, 1)), key=lambda f: f.accepted_at)
    assert [f.accepted_at.isoformat() for f in filings] == [
        "2024-02-01T23:00:00+00:00",
        "2024-02-29T19:00:00+00:00",
    ]
    assert [f.observations[0].value for f in filings] == [8, 7.5]
    assert not provider.filings("SYNT.L", since=date(2024, 1, 1))
    assert len(visited) == 4
