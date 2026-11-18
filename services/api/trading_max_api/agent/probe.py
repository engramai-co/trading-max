"""Connection check for an assistant model: it must be able to call a tool.

A plain completion is not enough for the assistant. Some local and OpenRouter
models answer text but never call tools, and would fail on every question.
"""

from __future__ import annotations

from pydantic_ai import Agent, Tool, UsageLimits
from pydantic_ai.exceptions import RunCancelled, UsageLimitExceeded
from pydantic_ai.settings import ModelSettings
from trading_max.llm import ModelConnection, ProviderError, build_model

from ..provider_runtime import ProviderRuntimeError
from .runtime import error_code

PROBE_VALUE = "ok"
PROBE_TIMEOUT_SECONDS = 30.0


async def check_assistant_connection(connection: ModelConnection) -> None:
    """Make one small tool-calling exchange with the model; raise a stable error otherwise."""

    calls: list[str] = []

    def connection_check(value: str) -> str:
        """Return the value unchanged."""

        calls.append(value)
        return value

    model = build_model(connection, timeout_s=PROBE_TIMEOUT_SECONDS, max_retries=0)
    agent = Agent(
        instructions=(
            "This is a connection check. Call the connection_check tool exactly once with "
            f"value '{PROBE_VALUE}', then reply with the single word it returns."
        ),
        tools=[Tool(connection_check)],
        retries=0,
        defer_model_check=True,
        name="trading-max-assistant-check",
    )
    try:
        async with model:
            await agent.run(
                "Run the connection check.",
                model=model,
                model_settings=ModelSettings(max_tokens=1_024),
                usage_limits=UsageLimits(request_limit=3, tool_calls_limit=2),
                cancellation_token=connection.cancellation_token,
            )
    except RunCancelled:
        raise ProviderRuntimeError(
            "assistant_settings_changed", "the assistant connection changed during the test"
        ) from None
    except UsageLimitExceeded:
        raise ProviderRuntimeError(
            "assistant_tools_unsupported", "the model did not finish a tool call"
        ) from None
    except ProviderRuntimeError:
        raise
    except Exception as exc:
        raise ProviderError(provider=connection.provider, code=error_code(exc)) from None
    if not calls:
        raise ProviderRuntimeError("assistant_tools_unsupported", "the model did not call a tool")


__all__ = ["check_assistant_connection"]
