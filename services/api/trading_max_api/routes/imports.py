"""Accept private, manually exported Trading 212 CFD CSV files."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from trading_max.ingestion.cfd_imports import MAX_CFD_IMPORT_BYTES, CfdImportError

from ..models import CfdImportResult, CfdImportStatus
from .dependencies import app_service, require_write_auth

router = APIRouter(prefix="/v1/imports/trading212/cfd", tags=["imports"])

_CSV_MEDIA_TYPES = frozenset(
    {
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
    }
)


async def _bounded_request_body(request: Request) -> bytes:
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_CFD_IMPORT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "code": "cfd_import_too_large",
                    "message": "the CFD CSV exceeds the 1 MB import limit",
                },
            )
    return bytes(content)


@router.get("", response_model=CfdImportStatus)
def cfd_import_status(request: Request) -> CfdImportStatus:
    imports = app_service(request, "cfd_imports")
    try:
        return CfdImportStatus.model_validate(imports.status())
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "cfd_import_state_unavailable",
                "message": str(exc),
            },
        ) from exc


@router.post(
    "",
    response_model=CfdImportResult,
    dependencies=[Depends(require_write_auth)],
)
async def import_cfd_csv(
    request: Request,
    filename: Annotated[
        str | None,
        Header(alias="X-Trading-Max-Filename"),
    ] = None,
) -> CfdImportResult:
    if filename is None or not filename.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "cfd_filename_required",
                "message": "X-Trading-Max-Filename is required",
            },
        )
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type not in _CSV_MEDIA_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail={
                "code": "cfd_csv_required",
                "message": "the CFD import must use an approved CSV media type",
            },
        )
    content = await _bounded_request_body(request)
    imports = app_service(request, "cfd_imports")
    try:
        result = imports.import_bytes(filename, content)
    except CfdImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "cfd_import_invalid",
                "message": str(exc),
            },
        ) from exc
    except (OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "cfd_import_state_unavailable",
                "message": str(exc),
            },
        ) from exc
    return CfdImportResult.model_validate(result)


__all__ = ["router"]
