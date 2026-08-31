from __future__ import annotations

import csv
import io
from pathlib import Path

from fastapi.testclient import TestClient
from trading_max.ingestion.cfd_imports import MAX_CFD_IMPORT_BYTES

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings


def _valid_csv() -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=[
            "Record Type",
            "Date (UTC)",
            "Account currency",
            "Transaction ID",
            "Transaction type",
            "Amount (account currency)",
        ],
        lineterminator="\n",
    )
    writer.writeheader()
    writer.writerow(
        {
            "Record Type": "Transaction",
            "Date (UTC)": "2026-01-01T00:00:00Z",
            "Account currency": "GBP",
            "Transaction ID": "deposit-1",
            "Transaction type": "Deposit",
            "Amount (account currency)": "100",
        }
    )
    return stream.getvalue().encode()


def _app(tmp_path: Path):
    return create_app(
        Settings(
            data_root=tmp_path / "state",
            api_token="secret",
            embedded_worker=False,
        )
    )


def test_cfd_import_get_post_raw_body_auth_and_content_type(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("TRADING_MAX_ENV", "development")
    app = _app(tmp_path)
    content = _valid_csv()
    auth = {"Authorization": "Bearer secret"}
    upload_headers = {
        **auth,
        "Content-Type": "text/csv; charset=utf-8",
        "X-Trading-Max-Filename": "synthetic.csv",
    }

    with TestClient(app) as client:
        empty = client.get("/v1/imports/trading212/cfd")
        assert empty.status_code == 200
        assert empty.json()["importedFiles"] == 0
        assert empty.json()["duplicateEvents"] == 0

        unauthorized = client.post(
            "/v1/imports/trading212/cfd",
            content=content,
            headers={
                "Content-Type": "text/csv",
                "X-Trading-Max-Filename": "synthetic.csv",
            },
        )
        assert unauthorized.status_code == 401

        missing_filename = client.post(
            "/v1/imports/trading212/cfd",
            content=content,
            headers={**auth, "Content-Type": "text/csv"},
        )
        assert missing_filename.status_code == 422
        assert missing_filename.json()["detail"]["code"] == "cfd_filename_required"

        for media_type in ("application/json", "application/octet-stream"):
            rejected = client.post(
                "/v1/imports/trading212/cfd",
                content=content,
                headers={
                    **auth,
                    "Content-Type": media_type,
                    "X-Trading-Max-Filename": "synthetic.csv",
                },
            )
            assert rejected.status_code == 415
            assert rejected.json()["detail"]["code"] == "cfd_csv_required"

        invalid = client.post(
            "/v1/imports/trading212/cfd",
            content=b"not,a,cfd,schema\n1,2,3,4\n",
            headers=upload_headers,
        )
        assert invalid.status_code == 422
        assert invalid.json()["detail"]["code"] == "cfd_import_invalid"

        imported = client.post(
            "/v1/imports/trading212/cfd",
            content=content,
            headers=upload_headers,
        )
        assert imported.status_code == 200
        payload = imported.json()
        assert payload["status"] == "imported"
        assert payload["file"]["filename"] == "synthetic.csv"
        assert payload["file"]["rawRows"] == 1
        assert payload["ledger"]["uniqueEvents"] == 1
        assert payload["ledger"]["duplicateEvents"] == 0

        original = app.state.cfd_imports.originals_root / f"{payload['file']['sha256']}.csv"
        assert original.read_bytes() == content

        duplicate = client.post(
            "/v1/imports/trading212/cfd",
            content=content,
            headers={**upload_headers, "X-Trading-Max-Filename": "renamed.csv"},
        )
        assert duplicate.status_code == 200
        assert duplicate.json()["status"] == "duplicate"
        assert duplicate.json()["ledger"]["importedFiles"] == 1

        status = client.get("/v1/imports/trading212/cfd")
        assert status.status_code == 200
        assert status.json()["uniqueEvents"] == 1
        assert status.json()["lastImportedAt"] is not None

        unauthorized_preference = client.put(
            "/v1/settings/cfd",
            json={"accountStatus": "retired"},
        )
        assert unauthorized_preference.status_code == 401

        retired = client.put(
            "/v1/settings/cfd",
            headers=auth,
            json={"accountStatus": "retired"},
        )
        assert retired.status_code == 200
        assert retired.json()["accountStatus"] == "retired"
        assert retired.json()["staleRemindersEnabled"] is False
        assert retired.json()["isStale"] is False

        persisted = client.get("/v1/imports/trading212/cfd")
        assert persisted.json()["accountStatus"] == "retired"

        oversized = client.post(
            "/v1/imports/trading212/cfd",
            content=b"x" * (MAX_CFD_IMPORT_BYTES + 1),
            headers=upload_headers,
        )
        assert oversized.status_code == 413
        assert oversized.json()["detail"]["code"] == "cfd_import_too_large"


def test_production_guard_allows_csv_only_for_the_cfd_route(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("TRADING_MAX_ENV", "production")
    app = _app(tmp_path)
    common = {
        "Authorization": "Bearer secret",
        "Host": "127.0.0.1",
        "X-Trading-Max-Filename": "synthetic.csv",
    }

    with TestClient(app) as client:
        accepted = client.post(
            "/v1/imports/trading212/cfd",
            content=_valid_csv(),
            headers={**common, "Content-Type": "Text/CSV; charset=utf-8"},
        )
        assert accepted.status_code == 200

        rejected = client.post(
            "/v1/imports/trading212/cfd",
            content=_valid_csv(),
            headers={**common, "Content-Type": "application/octet-stream"},
        )
        assert rejected.status_code == 415
        assert rejected.json()["code"] == "json_body_required"
