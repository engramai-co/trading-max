"""Assistant chat (Vercel AI SDK stream) and stored conversation endpoints."""

from __future__ import annotations

from contextlib import aclosing
from dataclasses import replace
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from pydantic import Field, ValidationError
from starlette.responses import StreamingResponse

from ..agent.readings import ReadingEvent, ReadingService
from ..agent.roles import role_registry
from ..agent.service import AssistantService, ChatFormat
from ..models import ApiModel
from .dependencies import require_write_auth

router = APIRouter(tags=["assistant"])
ConversationId = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


class AssistantConversation(ApiModel):
    id: str
    title: str | None = None
    updated_at: datetime


class AssistantConversationMessages(ApiModel):
    id: str
    messages: list[dict[str, Any]]


class AssistantStatus(ApiModel):
    ready: bool
    code: str | None = None
    provider: str | None = None
    model: str | None = None


def _service(request: Request) -> AssistantService:
    service = getattr(request.app.state, "assistant", None)
    if service is None:
        raise HTTPException(status_code=503, detail={"code": "assistant_unavailable"})
    return service


@router.post(
    "/v1/assistant/chat",
    dependencies=[Depends(require_write_auth)],
    response_class=Response,
    responses={200: {"description": "Vercel AI SDK UI message stream (SSE)."}},
)
async def assistant_chat(
    request: Request,
    response_format: Annotated[
        ChatFormat,
        Query(
            alias="format",
            description="Return prose or field references for the workspace sidebar.",
        ),
    ] = "prose",
) -> Response:
    return await _service(request).chat(request, response_format)


@router.get("/v1/assistant/status", response_model=AssistantStatus)
async def assistant_status(request: Request) -> AssistantStatus:
    return AssistantStatus.model_validate(await _service(request).status())


@router.get("/v1/assistant/conversations", response_model=list[AssistantConversation])
async def assistant_conversations(request: Request) -> list[AssistantConversation]:
    rows = await _service(request).conversations()
    return [AssistantConversation.model_validate(row) for row in rows]


@router.delete(
    "/v1/assistant/conversations",
    dependencies=[Depends(require_write_auth)],
    status_code=204,
    response_class=Response,
)
async def delete_assistant_conversations(request: Request) -> Response:
    await _service(request).delete_conversations()
    return Response(status_code=204)


@router.get(
    "/v1/assistant/conversations/{conversation_id}",
    response_model=AssistantConversationMessages,
)
async def assistant_conversation(
    request: Request, conversation_id: ConversationId
) -> AssistantConversationMessages:
    messages = await _service(request).messages(conversation_id)
    return AssistantConversationMessages(id=conversation_id, messages=messages)


@router.delete(
    "/v1/assistant/conversations/{conversation_id}",
    dependencies=[Depends(require_write_auth)],
    status_code=204,
    response_class=Response,
)
async def delete_assistant_conversation(
    request: Request, conversation_id: ConversationId
) -> Response:
    await _service(request).delete(conversation_id)
    return Response(status_code=204)


class ReadingStream(StreamingResponse):
    media_type = "application/x-ndjson"


class ReadingRequest(ApiModel):
    context: dict[str, Any] = Field(default_factory=dict, max_length=20)
    snapshot_id: str | None = Field(default=None, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    cached_only: bool = False
    latest: bool = False


@router.post(
    "/v1/assistant/roles/{role_id}/reading",
    dependencies=[Depends(require_write_auth)],
    response_class=ReadingStream,
    responses={
        200: {
            "model": ReadingEvent,
            "description": "Newline-delimited reading progress and final evidence-linked result.",
        }
    },
)
async def role_reading(request: Request, role_id: str, body: ReadingRequest) -> StreamingResponse:
    role = role_registry().get(role_id)
    if role is None:
        raise HTTPException(404, detail={"code": "assistant_role_unknown"})
    try:
        context = role.context_schema.model_validate(body.context)
    except ValidationError:
        raise HTTPException(422, detail={"code": "assistant_context_invalid"}) from None
    if body.latest and (not body.cached_only or not role.is_digest):
        raise HTTPException(422, detail={"code": "assistant_context_invalid"})
    service: ReadingService = request.app.state.assistant_readings
    deps = service.assistant.deps_for_run(role.page, None)
    if body.snapshot_id and body.snapshot_id != deps.snapshot_id:
        try:
            deps = replace(deps, manifest=deps.store.load_manifest(body.snapshot_id))
        except FileNotFoundError:
            raise HTTPException(404, detail={"code": "assistant_snapshot_missing"}) from None

    async def stream():
        async with aclosing(
            service.events(role, context, deps, cached_only=body.cached_only, latest=body.latest)
        ) as events:
            async for event in events:
                yield event.encode()

    return ReadingStream(stream(), headers={"Cache-Control": "private, no-store"})
