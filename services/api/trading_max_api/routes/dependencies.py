"""Provide shared FastAPI dependencies and write-request authorization."""

from __future__ import annotations

import hmac
from typing import Annotated, Any

from fastapi import Header, HTTPException, Request, status

from ..models import SnapshotManifest


def app_service(request: Request, name: str) -> Any:
    try:
        return getattr(request.app.state, name)
    except AttributeError as exc:
        raise RuntimeError(f"application service is not configured: {name}") from exc


def require_write_auth(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    settings = app_service(request, "settings")
    if settings.api_token is None:
        return
    scheme, _, candidate = (authorization or "").partition(" ")
    valid = scheme.lower() == "bearer" and hmac.compare_digest(
        candidate,
        settings.api_token,
    )
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="valid bearer token required",
            headers={"WWW-Authenticate": "Bearer"},
        )


def latest_or_503(request: Request) -> SnapshotManifest:
    store = app_service(request, "store")
    manifest = store.latest_manifest()
    if manifest is None:
        detail = request.app.state.bootstrap_error or "no published snapshot"
        raise HTTPException(status_code=503, detail=detail)
    return manifest
