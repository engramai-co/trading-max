"""Assistant runtime: Pydantic AI loop, Vercel AI stream and SQLite conversations."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import anyio
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic_ai import Agent, Conversation, FunctionToolset, RunContext, Tool
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelRequest, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.models.wrapper import WrapperModel
from trading_max.infrastructure import SqliteDatabase

from services.api.trading_max_api.agent import service as service_module
from services.api.trading_max_api.agent.runtime import build_assistant_agent, run_settings
from services.api.trading_max_api.agent.service import (
    AssistantService,
    AssistantUnavailable,
    BoundModel,
)
from services.api.trading_max_api.agent.store import SqliteConversationStore
from services.api.trading_max_api.routes.assistant import router

MIGRATIONS = Path(__file__).resolve().parents[3] / "backend" / "migrations"


@dataclass(frozen=True)
class SyntheticDeps:
    page: str | None
    timezone: str | None
    total: float = 1234.5


def lookup_total(ctx: RunContext[SyntheticDeps]) -> dict:
    """Synthetic portfolio total."""
    return {"status": "ok", "data": {"total": ctx.deps.total}, "evidence_id": "ev_test"}


def save_note(ctx: RunContext[SyntheticDeps], text: str) -> str:
    """A synthetic write that needs approval (infrastructure check only)."""
    return f"saved:{text}"


def toolset() -> FunctionToolset:
    return FunctionToolset([Tool(lookup_total), Tool(save_note, requires_approval=True)])


def database(path: Path) -> SqliteDatabase:
    return SqliteDatabase(path / "trading_max.db", migrations_dir=MIGRATIONS)


def answer_after_tool(tool: str, args: str = "{}"):
    seen: list[list] = []

    async def stream(messages, info: AgentInfo):
        seen.append(list(messages))
        last = messages[-1]
        if isinstance(last, ModelRequest) and any(
            isinstance(part, ToolReturnPart) for part in last.parts
        ):
            yield "Total is "
            yield "1,234.50 [ev_test]."
            return
        yield {0: DeltaToolCall(name=tool, json_args=args, tool_call_id=f"call_{len(seen)}")}

    return stream, seen


def make_app(tmp_path: Path, stream, *, bind=None) -> tuple[FastAPI, AssistantService]:
    async def bound() -> BoundModel:
        return BoundModel(FunctionModel(stream_function=stream), run_settings(None))

    service = AssistantService(
        agent=build_assistant_agent([toolset()]),
        store=SqliteConversationStore(database(tmp_path)),
        bind_model=bind or bound,
        deps_for_run=lambda page, tz: SyntheticDeps(page, tz),
    )
    app = FastAPI()
    app.state.settings = type("S", (), {"api_token": None})()
    app.state.assistant = service
    app.include_router(router)
    return app, service


def events(body: str) -> list[dict]:
    return [
        json.loads(line[6:])
        for line in body.splitlines()
        if line.startswith("data: ") and line[6:] != "[DONE]"
    ]


def user_turn(chat: str, message_id: str, text: str) -> dict:
    return {
        "trigger": "submit-message",
        "id": chat,
        "messages": [{"id": message_id, "role": "user", "parts": [{"type": "text", "text": text}]}],
    }


def test_store_survives_a_fresh_process_and_prunes_on_delete(tmp_path):
    async def scenario():
        agent = Agent(TestModel())
        store = SqliteConversationStore(database(tmp_path))
        conversation = await store.load("c1") or Conversation(conversation_id="c1")
        result = await agent.run("What is my total?", conversation=conversation)
        await store.save(result, scope="workspace")

        fresh = SqliteConversationStore(database(tmp_path))
        loaded = await fresh.load("c1", scope="workspace")
        assert loaded is not None
        assert len(loaded.messages) == len(result.all_messages())
        assert await fresh.load("c1", scope="other") is None
        assert [r.conversation_id for r in await fresh.list_conversations(scope="workspace")] == [
            "c1"
        ]
        assert (await fresh.titles(["c1"]))["c1"] == "What is my total?"
        assert len(await fresh.read_history((await fresh.read_record("c1")).head_id, limit=1)) == 1

        await fresh.delete("c1", scope="workspace")
        assert await fresh.read_record("c1") is None
        with fresh._database.read() as connection:  # noqa: SLF001 - verifying erasure
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM assistant_conversation_entries"
                ).fetchone()[0]
                == 0
            )

    import asyncio

    asyncio.run(scenario())


def test_stale_revision_is_a_conflict(tmp_path):
    from pydantic_ai.conversation_store import ConversationConflict

    async def scenario():
        store = SqliteConversationStore(database(tmp_path))
        agent = Agent(TestModel())
        result = await agent.run("hello", conversation=Conversation(conversation_id="c2"))
        await store.save(result)
        record = await store.read_record("c2")
        with pytest.raises(ConversationConflict):
            await store.write_record(record, expected_revision="not-the-revision")

    import asyncio

    asyncio.run(scenario())


def test_chat_streams_a_tool_grounded_answer_and_keeps_history_on_the_server(tmp_path):
    stream, seen = answer_after_tool("lookup_total")
    app, _ = make_app(tmp_path, stream)
    client = TestClient(app)

    first = client.post(
        "/v1/assistant/chat?page=overview&tz=Asia/Shanghai",
        json=user_turn("chat1", "u1", "What is my total?"),
    )
    assert first.status_code == 200
    chunks = events(first.text)
    kinds = [chunk["type"] for chunk in chunks]
    assert "tool-input-available" in kinds and "tool-output-available" in kinds
    text = "".join(chunk.get("delta", "") for chunk in chunks if chunk["type"] == "text-delta")
    assert text == "Total is 1,234.50 [ev_test]."
    assert any(chunk.get("type") == "data-conversation-saved" for chunk in chunks)
    instructions = seen[0][0].instructions or ""
    assert "Asia/Shanghai" in instructions and "overview page" in instructions

    listed = client.get("/v1/assistant/conversations").json()
    assert [row["id"] for row in listed] == ["chat1"]
    assert listed[0]["title"] == "What is my total?"

    # The second turn sends only the new message; the server supplies the history.
    second = client.post("/v1/assistant/chat", json=user_turn("chat1", "u2", "And again?"))
    assert second.status_code == 200
    history = seen[-2]
    assert any(
        isinstance(message, ModelRequest)
        and any(getattr(part, "content", None) == "What is my total?" for part in message.parts)
        for message in history
    )

    stored = client.get("/v1/assistant/conversations/chat1").json()
    assert stored["id"] == "chat1"
    assert [message["role"] for message in stored["messages"]].count("user") == 2

    assert client.delete("/v1/assistant/conversations/chat1").status_code == 204
    assert client.get("/v1/assistant/conversations/chat1").status_code == 404


def test_follow_ups_have_independent_request_tool_and_token_budgets(tmp_path, monkeypatch):
    from pydantic_ai import UsageLimits

    monkeypatch.setattr(
        service_module,
        "USAGE_LIMITS",
        UsageLimits(request_limit=2, tool_calls_limit=1, total_tokens_limit=10000),
    )
    stream, seen = answer_after_tool("lookup_total")
    app, service = make_app(tmp_path, stream)
    with TestClient(app) as client:
        for index in range(6):
            response = client.post(
                "/v1/assistant/chat", json=user_turn("long", f"u{index}", f"Turn {index}")
            )
            assert any(c["type"] == "data-conversation-saved" for c in events(response.text))
        assert len(seen) == 12
        record = anyio.run(service.store.read_record, "long")
        assert (record.usage.requests, record.usage.tool_calls) == (12, 6)
        monkeypatch.setattr(service_module, "USAGE_LIMITS", UsageLimits(request_limit=1))
        response = client.post("/v1/assistant/chat", json=user_turn("long", "too-long", "Again"))
        assert any(c.get("errorText") == "assistant_limit_reached" for c in events(response.text))


def test_unavailable_assistant_and_invalid_ids_are_rejected_before_any_run(tmp_path):
    async def disabled() -> BoundModel:
        raise AssistantUnavailable("assistant_disabled", 403)

    stream, seen = answer_after_tool("lookup_total")
    app, _ = make_app(tmp_path, stream, bind=disabled)
    client = TestClient(app)
    response = client.post("/v1/assistant/chat", json=user_turn("chat2", "u1", "hi"))
    assert response.status_code == 403
    assert response.json() == {"detail": {"code": "assistant_disabled"}}
    bad = client.post("/v1/assistant/chat", json=user_turn("../etc", "u1", "hi"))
    assert bad.status_code == 422
    assert seen == []


def test_upstream_error_text_never_reaches_the_client(tmp_path):
    async def failing(messages, info: AgentInfo):
        raise ModelHTTPError(
            status_code=401, model_name="m", body={"error": "key sk-SECRET at https://x"}
        )
        yield ""  # pragma: no cover - makes this an async generator

    app, _ = make_app(tmp_path, failing)
    response = TestClient(app).post("/v1/assistant/chat", json=user_turn("chat3", "u1", "hi"))
    assert response.status_code == 200
    errors = [chunk for chunk in events(response.text) if chunk["type"] == "error"]
    assert errors and errors[0]["errorText"] == "provider_auth_failed"
    assert "SECRET" not in response.text and "https://x" not in response.text
    # A failed run is not saved.
    assert TestClient(app).get("/v1/assistant/conversations").json() == []


def test_an_approval_resumes_in_a_fresh_process(tmp_path):
    stream, _ = answer_after_tool("save_note", '{"text":"hi"}')
    app, _ = make_app(tmp_path, stream)
    first = TestClient(app).post("/v1/assistant/chat", json=user_turn("chat4", "u1", "save hi"))
    request = next(c for c in events(first.text) if c["type"] == "tool-approval-request")
    call = next(c for c in events(first.text) if c["type"] == "tool-input-available")

    # A new service on the same database stands in for a restarted API process.
    restarted, _ = make_app(tmp_path, stream)
    approve = {
        "trigger": "submit-message",
        "id": "chat4",
        "messages": [
            {
                "id": "a1",
                "role": "assistant",
                "parts": [
                    {
                        "type": "tool-save_note",
                        "toolCallId": call["toolCallId"],
                        "state": "approval-responded",
                        "input": {"text": "hi"},
                        "approval": {"id": request["approvalId"], "approved": True},
                    }
                ],
            }
        ],
    }
    second = TestClient(restarted).post("/v1/assistant/chat", json=approve)
    outputs = [c for c in events(second.text) if c["type"] == "tool-output-available"]
    assert outputs and outputs[0]["output"] == "saved:hi"


class CountingModel(WrapperModel):
    """Records context entry and exit, which own the provider's HTTP client."""

    def __init__(self, wrapped):
        super().__init__(wrapped)
        self.entered = 0
        self.exited = 0

    async def __aenter__(self):
        self.entered += 1
        return await super().__aenter__()

    async def __aexit__(self, *args):
        self.exited += 1
        return await super().__aexit__(*args)


def test_the_model_client_is_released_after_the_stream(tmp_path):
    stream, _ = answer_after_tool("lookup_total")
    model = CountingModel(FunctionModel(stream_function=stream))

    async def bound() -> BoundModel:
        return BoundModel(model, run_settings(None))

    app, _ = make_app(tmp_path, stream, bind=bound)
    response = TestClient(app).post("/v1/assistant/chat", json=user_turn("chat5", "u1", "hi"))
    assert response.status_code == 200
    assert (model.entered, model.exited) == (1, 1)


def test_closing_the_connection_cancels_the_run(tmp_path):
    import socket
    import threading
    import time

    import httpx
    import uvicorn

    started = threading.Event()

    async def slow(messages, info: AgentInfo):
        yield "first "
        started.set()
        for _ in range(100):
            await anyio.sleep(0.05)
            yield "."

    model = CountingModel(FunctionModel(stream_function=slow))

    async def bound() -> BoundModel:
        return BoundModel(model, run_settings(None))

    app, _ = make_app(tmp_path, slow, bind=bound)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.02)
        with (
            httpx.Client(timeout=10) as client,
            client.stream(
                "POST",
                f"http://127.0.0.1:{port}/v1/assistant/chat",
                json=user_turn("chat6", "u1", "go"),
            ) as response,
        ):
            assert response.status_code == 200
            for _ in response.iter_raw():
                if started.is_set():
                    break
        deadline = time.monotonic() + 5
        while model.exited == 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        assert model.exited == 1
        # A stopped run is not saved.
        assert TestClient(app).get("/v1/assistant/conversations").json() == []
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def test_page_context_reaches_the_run_and_bad_context_is_refused(tmp_path):
    stream, seen = answer_after_tool("lookup_total")
    app, _ = make_app(tmp_path, stream)
    client = TestClient(app)
    body = user_turn("chat7", "u1", "How is it doing?")
    body["context"] = {
        "page": "research",
        "scope": "isa",
        "range": "3M",
        "ticker": "nvda",
        "lens": "valuation",
        "timezone": "America/New_York",
    }
    assert client.post("/v1/assistant/chat", json=body).status_code == 200
    instructions = seen[0][0].instructions or ""
    assert "America/New_York" in instructions
    assert "the research page" in instructions
    assert "the isa account scope" in instructions and "the 3M range" in instructions
    assert "security NVDA" in instructions and "valuation research view" in instructions

    for bad in ({"scope": "everything"}, {"page": "overview", "sql": "1"}, {"ticker": "../x"}):
        refused = client.post(
            "/v1/assistant/chat", json={**user_turn("chat8", "u1", "hi"), "context": bad}
        )
        assert refused.status_code == 422
        assert refused.json() == {"detail": {"code": "assistant_context_invalid"}}
    assert len(seen) == 2  # one tool call and one answer, from the first request only


def test_one_run_per_conversation_and_a_global_cap(tmp_path):
    stream, seen = answer_after_tool("lookup_total")
    app, service = make_app(tmp_path, stream)
    client = TestClient(app)
    service._active["chat9"] = time.monotonic()  # noqa: SLF001 - a run in progress
    busy = client.post("/v1/assistant/chat", json=user_turn("chat9", "u1", "hi"))
    assert (busy.status_code, busy.json()) == (409, {"detail": {"code": "assistant_busy"}})
    service._active["other"] = time.monotonic()  # noqa: SLF001
    capped = client.post("/v1/assistant/chat", json=user_turn("chat10", "u1", "hi"))
    assert capped.status_code == 429
    assert seen == []
    # A slot abandoned before streaming began expires after the run timeout.
    # Relative to now: a freshly booted CI runner has a small monotonic clock.
    abandoned = time.monotonic() - service_module.RUN_TIMEOUT_SECONDS - 60
    service._active["chat9"] = service._active["other"] = abandoned  # noqa: SLF001
    assert client.post("/v1/assistant/chat", json=user_turn("chat9", "u1", "hi")).status_code == 200
    assert service._active == {}  # noqa: SLF001 - released when the stream ended


def test_a_looping_model_stops_at_the_run_limit(tmp_path, caplog):
    async def loop(messages, info: AgentInfo):
        yield {
            0: DeltaToolCall(name="lookup_total", json_args="{}", tool_call_id=f"c{len(messages)}")
        }

    app, _ = make_app(tmp_path, loop)
    with caplog.at_level("WARNING", logger="trading_max.assistant"):
        response = TestClient(app).post("/v1/assistant/chat", json=user_turn("chat11", "u1", "x"))
    errors = [chunk for chunk in events(response.text) if chunk["type"] == "error"]
    assert [chunk["errorText"] for chunk in errors] == ["assistant_limit_reached"]


def test_invalid_tool_arguments_are_retried(tmp_path):
    attempts: list[str] = []

    async def stream(messages, info: AgentInfo):
        last = messages[-1]
        returns = (
            [p for p in last.parts if isinstance(p, ToolReturnPart)]
            if isinstance(last, ModelRequest)
            else []
        )
        if any(part.content == "saved:hi" for part in returns):
            yield "Saved."
            return
        args = '{"wrong": 1}' if not attempts else '{"text": "hi"}'
        attempts.append(args)
        yield {
            0: DeltaToolCall(name="lookup_note", json_args=args, tool_call_id=f"n{len(attempts)}")
        }

    def lookup_note(ctx: RunContext[SyntheticDeps], text: str) -> str:
        """Read-only synthetic tool with a required argument."""
        return f"saved:{text}"

    async def bound() -> BoundModel:
        return BoundModel(FunctionModel(stream_function=stream), run_settings(None))

    app, service = make_app(tmp_path, stream, bind=bound)
    service.agent = build_assistant_agent([FunctionToolset([Tool(lookup_note)])])
    response = TestClient(app).post("/v1/assistant/chat", json=user_turn("chat12", "u1", "x"))
    text = "".join(c.get("delta", "") for c in events(response.text) if c["type"] == "text-delta")
    assert attempts == ['{"wrong": 1}', '{"text": "hi"}']
    assert text == "Saved."


def test_a_run_that_outlasts_its_timeout_is_aborted_and_not_saved(tmp_path, monkeypatch, caplog):

    async def slow(messages, info: AgentInfo):
        yield "starting "
        await anyio.sleep(5)
        yield "never"

    monkeypatch.setattr(service_module, "RUN_TIMEOUT_SECONDS", 0.3)
    app, service = make_app(tmp_path, slow)
    with caplog.at_level("INFO", logger="trading_max.assistant"):
        response = TestClient(app).post("/v1/assistant/chat", json=user_turn("chat13", "u1", "x"))
    assert any(chunk["type"] == "abort" for chunk in events(response.text))
    assert TestClient(app).get("/v1/assistant/conversations").json() == []
    assert any(getattr(r, "status", None) == "timed_out" for r in caplog.records)
    assert service._active == {}  # noqa: SLF001


def test_completed_runs_log_usage_metadata_only(tmp_path, caplog):
    stream, _ = answer_after_tool("lookup_total")
    app, _ = make_app(tmp_path, stream)
    with caplog.at_level("INFO", logger="trading_max.assistant"):
        TestClient(app).post(
            "/v1/assistant/chat", json=user_turn("chat14", "u1", "secret question")
        )
    record = next(r for r in caplog.records if r.getMessage() == "assistant run finished")
    assert (record.status, record.requests, record.tool_calls) == ("completed", 2, 1)
    assert "secret question" not in caplog.text


def test_the_wired_app_reports_why_the_assistant_cannot_start(tmp_path):
    from services.api.trading_max_api.app import create_app
    from services.api.trading_max_api.config import Settings
    from services.api.trading_max_api.credentials import InMemoryCredentialStore

    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    with TestClient(app) as client:
        assert client.get("/v1/assistant/status").json() == {
            "ready": False,
            "code": "assistant_disabled",
            "provider": None,
            "model": None,
        }
        refused = client.post("/v1/assistant/chat", json=user_turn("chat15", "u1", "hi"))
        assert refused.status_code == 403
        assert client.get("/v1/assistant/conversations").json() == []


@pytest.mark.parametrize("budget", ["requests", "parallel_tools", "tokens"])
def test_single_turn_rejects_excess_usage_before_saving(tmp_path, monkeypatch, budget):
    from pydantic_ai import UsageLimits

    limits = {
        "requests": UsageLimits(request_limit=1),
        "parallel_tools": UsageLimits(tool_calls_limit=1),
        "tokens": UsageLimits(total_tokens_limit=1),
    }
    monkeypatch.setattr(service_module, "USAGE_LIMITS", limits[budget])

    async def stream(messages, info):
        if any(isinstance(part, ToolReturnPart) for part in messages[-1].parts):
            yield "Complete"
        elif budget == "tokens":
            yield "A complete answer exceeding a single token"
        else:
            yield {
                i: DeltaToolCall(name="lookup_total", json_args="{}", tool_call_id=f"call_{i}")
                for i in range(2 if budget == "parallel_tools" else 1)
            }

    app, service = make_app(tmp_path, stream)
    response = TestClient(app).post("/v1/assistant/chat", json=user_turn("over", "u", "Question"))
    chunks = events(response.text)
    assert [c["errorText"] for c in chunks if c["type"] == "error"] == ["assistant_limit_reached"]
    assert not any(c["type"] == "data-conversation-saved" for c in chunks)
    assert anyio.run(service.store.read_record, "over") is None


def test_delete_all_conversations_clears_the_workspace_beyond_the_recent_list(
    tmp_path, monkeypatch
):
    stream, _ = answer_after_tool("lookup_total")
    app, service = make_app(tmp_path, stream)
    client = TestClient(app)
    path = "/v1/assistant/conversations"
    for chat in ("first", "second"):
        client.post(
            "/v1/assistant/chat", json=user_turn(chat, "u1", "Synthetic question")
        ).raise_for_status()
    monkeypatch.setattr(service_module, "LIST_LIMIT", 1)
    assert len(client.get(path).json()) == 1
    app.state.settings.api_token = "synthetic-token"
    assert client.delete(path).status_code == 401
    headers = {"Authorization": "Bearer synthetic-token"}
    service._active["ongoing"] = time.monotonic()  # noqa: SLF001 - synthetic active turn
    assert client.delete(path, headers=headers).status_code == 409
    service._active.clear()  # noqa: SLF001
    assert client.delete(path, headers=headers).status_code == 204
    assert client.delete(path, headers=headers).status_code == 204
    assert client.get(path).json() == []
    with service.store._database.read() as connection:  # noqa: SLF001 - check stored messages
        assert (
            connection.execute("SELECT COUNT(*) FROM assistant_conversation_entries").fetchone()[0]
            == 0
        )
