"""Assistant chat (Vercel AI SDK stream) and stored conversation endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response

from ..agent.service import AssistantService
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
async def assistant_chat(request: Request) -> Response:
    return await _service(request).chat(request)


@router.get("/v1/assistant/conversations", response_model=list[AssistantConversation])
async def assistant_conversations(request: Request) -> list[AssistantConversation]:
    rows = await _service(request).conversations()
    return [AssistantConversation.model_validate(row) for row in rows]


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
