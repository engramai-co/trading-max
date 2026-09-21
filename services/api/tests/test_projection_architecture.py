"""Keep pure projections reusable without importing API orchestration."""

import ast
from pathlib import Path


def test_projections_do_not_depend_on_route_or_storage_layers():
    root = Path(__file__).resolve().parents[1] / "trading_max_api/projections"
    forbidden = {"dashboard", "research", "app", "artifacts", "history_reader", "routes"}
    for path in root.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and node.level >= 2:
                assert not set((node.module or "").split(".")) & forbidden, path.name
            elif isinstance(node, ast.Import):
                assert not any(
                    alias.name.startswith(("fastapi", "services.api.trading_max_api"))
                    for alias in node.names
                ), path.name
