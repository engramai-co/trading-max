"""Translate Trading Max's bounded synthesis requests and replies at the model boundary."""

from __future__ import annotations

from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.tools import ToolDefinition

from .model import ModelConnection, ProviderError, build_model, request_errors

_CHAT_COMPLETIONS = frozenset({"deepseek", "opencode", "openrouter", "ollama", "lmstudio"})
_APIS = {
    "openai": "openai-responses",
    "openai-codex": "openai-codex-responses",
    "anthropic": "anthropic-messages",
    "google": "google-generative-ai",
}
_CODEX_DEFAULT_INSTRUCTIONS = "You are a helpful assistant."


def _text(content: str | list[dict]) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(part["text"] for part in content if part.get("type") == "text")


def _history(provider: str, messages: list[dict], system: str) -> list[ModelMessage]:
    history: list[ModelMessage] = []
    for message in messages:
        role = message["role"]
        if role == "user":
            parts = [UserPromptPart(_text(message["content"]))]
            if not history and system and provider != "openai-codex":
                parts.insert(0, SystemPromptPart(system))
            history.append(
                ModelRequest(
                    parts=parts,
                    instructions=(system or _CODEX_DEFAULT_INSTRUCTIONS)
                    if provider == "openai-codex"
                    else None,
                )
            )
        elif role == "assistant":
            parts = []
            for part in message["content"]:
                kind = part["type"]
                if kind == "text":
                    parts.append(
                        TextPart(
                            part["text"],
                            provider_name=provider,
                            provider_details={"thought_signature": part["textSignature"]}
                            if provider == "google" and part.get("textSignature")
                            else None,
                        )
                    )
                elif kind == "toolCall":
                    call_id, _, item_id = part["id"].partition("|")
                    # Gemini assigns IDs only when the provider itself sent
                    # them; the generated Pi reference is local bookkeeping.
                    parts.append(
                        ToolCallPart(
                            part["name"],
                            part["arguments"],
                            call_id,
                            id=item_id or None,
                            provider_name=provider,
                            provider_details={"thought_signature": part["thoughtSignature"]}
                            if provider == "google" and part.get("thoughtSignature")
                            else None,
                        )
                    )
                elif kind == "thinking":
                    parts.append(
                        ThinkingPart(
                            part["thinking"],
                            signature=part.get("thinkingSignature"),
                            provider_name=provider,
                        )
                    )
            history.append(
                ModelResponse(parts=parts, provider_name=provider, model_name=message.get("model"))
            )
        elif role == "toolResult":
            call_id, _, _ = message["toolCallId"].partition("|")
            text = _text(message["content"])
            content = (
                {"output": text} if provider == "google" and not message.get("isError") else text
            )
            history.append(
                ModelRequest(
                    parts=[
                        ToolReturnPart(
                            message["toolName"],
                            content,
                            call_id,
                            outcome="failed" if message.get("isError") else "success",
                        )
                    ],
                    instructions=(system or _CODEX_DEFAULT_INSTRUCTIONS)
                    if provider == "openai-codex"
                    else None,
                )
            )
        else:
            raise ProviderError(provider=provider, code="provider_invalid_output")
    return history


def _options(
    connection: ModelConnection,
    tools: list[dict],
    tool_choice: str | None,
    json_output: bool,
    schema: dict | None,
    max_tokens: int,
    temperature: float,
) -> tuple[dict, ModelRequestParameters]:
    provider = connection.provider
    model = connection.model
    settings: dict[str, Any] = {"temperature": temperature, "max_tokens": max_tokens}
    extra: dict[str, Any] = {}
    if provider == "openai":
        settings["max_tokens"] = max(16, max_tokens)
        settings["openai_send_reasoning_ids"] = True
        if model.startswith(("gpt-5", "o")) and "chat" not in model:
            settings["openai_reasoning_effort"] = "none"
            extra["reasoning"] = {"effort": "none"}
        if schema:
            extra["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "trading_max_synthesis",
                    "strict": True,
                    "schema": schema,
                }
            }
    elif provider == "openai-codex":
        settings = {"openai_text_verbosity": "low"}
        extra = {
            "tool_choice": tool_choice or "auto",
            "parallel_tool_calls": True,
            "include": ["reasoning.encrypted_content"],
            "reasoning": {"effort": "none"},
        }
        if tools:
            extra["tools"] = [
                {
                    "type": "function",
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool["parameters"],
                    "strict": None,
                }
                for tool in tools
            ]
    elif provider == "anthropic":
        settings["anthropic_eager_input_streaming"] = True
        if model.startswith("claude-fable-5"):
            settings.pop("temperature")
            settings["anthropic_effort"] = "high"
            settings["anthropic_thinking"] = {"type": "adaptive", "display": "summarized"}
            extra["thinking"] = {
                "type": "adaptive",
                "display": "summarized",
                "block_binding": {"prefix_mismatch_behavior": "drop_block"},
            }
        else:
            settings["anthropic_thinking"] = {"type": "disabled"}
        if tool_choice and tools:
            # Keep Pi's Anthropic wire dialect, including the legacy tool-choice value.
            extra["tool_choice"] = {"type": tool_choice}
    elif provider == "google":
        settings["thinking"] = False
        if model == "gemini-2.5-pro":
            settings.pop("thinking")
            settings["google_thinking_config"] = {"thinking_budget": 0}
        if json_output:
            tools, tool_choice = [], None
        elif tool_choice == "required":
            tool_choice = "auto"  # Pi maps "any" to ANY, and "required" to AUTO.
    elif provider in _CHAT_COMPLETIONS:
        if json_output:
            extra["response_format"] = {"type": "json_object"}
        if provider in {"deepseek", "opencode"}:
            extra["thinking"] = {"type": "disabled"}

    if tool_choice is not None and not (provider == "anthropic" and tool_choice == "required"):
        settings["tool_choice"] = tool_choice
    if extra:
        settings["extra_body"] = extra
    return settings, ModelRequestParameters(
        function_tools=[
            ToolDefinition(
                name=tool["name"],
                description=tool.get("description"),
                parameters_json_schema=(
                    {k: v for k, v in tool["parameters"].items() if k != "additionalProperties"}
                    if provider == "anthropic"
                    else tool["parameters"]
                ),
                strict=False if provider in {"openai", "deepseek", "opencode", "google"} else None,
            )
            for tool in tools
        ],
        output_mode="prompted" if provider == "google" and json_output else "text",
        prompted_output_template=False,
    )


def _completion(
    response: ModelResponse,
    connection: ModelConnection,
    tools: list[dict],
    tool_choice: str | None,
):
    provider = connection.provider

    def fail(code: str) -> None:
        raise ProviderError(provider=provider, code=code)

    if response.finish_reason == "length":
        fail("provider_invalid_output")
    if response.finish_reason in {"content_filter", "error", None}:
        fail("provider_unavailable")
    if response.finish_reason not in {"stop", "tool_call"} or response.state != "complete":
        fail("provider_invalid_output")
    parts = []
    for part in response.parts:
        if isinstance(part, TextPart):
            text_part = {"type": "text", "text": part.content}
            if provider == "google" and (
                signature := (part.provider_details or {}).get("thought_signature")
            ):
                text_part["textSignature"] = signature
            parts.append(text_part)
        elif isinstance(part, ToolCallPart):
            if not tools or tool_choice == "none":
                fail("provider_invalid_output")
            call_id = part.tool_call_id
            if provider in {"openai", "openai-codex"} and part.id and "|" not in call_id:
                call_id += "|" + part.id
            tool_part = {
                "type": "toolCall",
                "name": part.tool_name,
                "id": call_id,
                "arguments": part.args_as_dict(),
            }
            if provider == "google" and (
                signature := (part.provider_details or {}).get("thought_signature")
            ):
                tool_part["thoughtSignature"] = signature
            parts.append(tool_part)
        elif isinstance(part, ThinkingPart):
            thinking = {"type": "thinking", "thinking": part.content}
            if part.signature:
                thinking["thinkingSignature"] = part.signature
            parts.append(thinking)
    tool_used = response.finish_reason == "tool_call" or any(p["type"] == "toolCall" for p in parts)
    if tool_used and (not tools or tool_choice == "none"):
        fail("provider_invalid_output")
    usage = response.usage
    mapped_usage = {
        "input": max(0, usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens),
        "output": usage.output_tokens,
        "cacheRead": usage.cache_read_tokens,
        "cacheWrite": usage.cache_write_tokens,
        "totalTokens": usage.total_tokens,
    }
    return {
        "text": _text(parts),
        "usage": mapped_usage,
        "message": {
            "role": "assistant",
            "content": parts,
            "provider": provider,
            "api": _APIS.get(provider, "openai-completions"),
            "model": connection.model,
            "usage": mapped_usage,
            "stopReason": "toolUse" if tool_used else "stop",
            "timestamp": int(response.timestamp.timestamp() * 1000),
        },
    }


async def request_completion(
    connection: ModelConnection,
    *,
    messages: list[dict],
    system: str = "",
    tools: list[dict] | None = None,
    tool_choice: str | None = None,
    json_output: bool = False,
    schema: dict | None = None,
    max_tokens: int = 12_000,
    temperature: float = 0.1,
    timeout_s: float = 180,
    max_retries: int = 2,
) -> dict:
    """Use the selected provider's native SSE transport for a single bounded completion."""

    tools = tools or []
    async with request_errors(connection.provider, timeout_s):
        settings, parameters = _options(
            connection, tools, tool_choice, json_output, schema, max_tokens, temperature
        )
        history = _history(connection.provider, messages, system)
        model = build_model(connection, timeout_s=timeout_s, max_retries=max_retries)
        async with model, model.request_stream(history, settings, parameters) as stream:
            async for _ in stream:
                pass
            response = stream.get()
        return _completion(response, connection, tools, tool_choice)


async def check_connection(connection: ModelConnection) -> None:
    """Verify that a saved provider can generate a short reply without retrying."""

    result = await request_completion(
        connection,
        messages=[{"role": "user", "content": "Reply with OK."}],
        max_tokens=32,
        temperature=0,
        timeout_s=20,
        max_retries=0,
    )
    if not result["text"].strip():
        raise ProviderError(provider=connection.provider, code="provider_invalid_output")
