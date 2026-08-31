"""Trading Max API package without import-time application side effects."""

from typing import Any

__all__ = ["app", "create_app"]


def __getattr__(name: str) -> Any:
    if name == "app":
        from .app import app

        return app
    if name == "create_app":
        from .app import create_app

        return create_app
    raise AttributeError(name)
