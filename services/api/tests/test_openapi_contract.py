import json
from pathlib import Path

from services.api.trading_max_api.app import create_app

ROOT = Path(__file__).resolve().parents[3]
CONTRACT = ROOT / "contracts" / "openapi.json"


def test_openapi_snapshot_is_current() -> None:
    expected = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert create_app().openapi() == expected


def test_openapi_snapshot_contains_public_contract_surface() -> None:
    contract = create_app().openapi()
    paths = contract["paths"]
    for path in (
        "/health",
        "/v1/dashboard",
        "/v1/dashboard/lens/{view}",
        "/v1/refresh-state",
        "/v1/jobs/refresh",
        "/v1/research",
        "/v1/research/shell",
        "/v1/research/{ticker}/lens/{view}",
        "/v1/watchlist",
        "/v1/analysis/runs",
    ):
        assert path in paths

    dashboard_response = paths["/v1/dashboard"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]
    assert dashboard_response == {
        "$ref": "#/components/schemas/DashboardResponse",
    }

    schemas = contract["components"]["schemas"]
    for schema_name in (
        "AccountSummary",
        "DashboardResponse",
        "DashboardLensSnapshot",
        "JobRecord",
        "ResearchLensSnapshot",
        "ResearchDirectoryInstrument",
        "ResearchShell",
        "RefreshState",
        "RiskMetrics",
    ):
        assert schema_name in schemas
