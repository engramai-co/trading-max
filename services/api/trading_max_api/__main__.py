"""Run the Trading Max FastAPI service with validated runtime settings."""

from __future__ import annotations

import uvicorn


def main() -> None:
    from .config import Settings

    settings = Settings.from_env()
    settings.validate_runtime_mode()
    uvicorn.run(
        "services.api.trading_max_api.app:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=False,
        workers=1,
    )


if __name__ == "__main__":
    main()
