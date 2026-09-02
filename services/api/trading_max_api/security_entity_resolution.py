"""Resolve colloquial company queries with one bounded web-search tool call."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from .provider_runtime import ProviderRuntimeError

WEB_SEARCH_MCP_URL = "https://mcp.exa.ai/mcp"
TICKER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,14}$")


@dataclass(frozen=True, slots=True)
class WebEntityResolution:
    """A model proposal that still requires deterministic market validation."""

    company_name: str
    search_queries: tuple[str, ...]
    evidence_urls: tuple[str, ...] = ()
    provider_model: str = ""


class OpenCodeWebSearchResolver:
    """Run an approved model tool loop with only one web search exposed.

    The historical class name remains public for compatibility. Runtime routing
    may supply OpenCode or direct DeepSeek; both use the same bounded,
    OpenAI-compatible tool-call contract.
    """

    def __init__(
        self,
        provider_factory: Callable[[str | None], Any],
        *,
        timeout: float = 30.0,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.provider_factory = provider_factory
        self.timeout = timeout
        self._http = http_client

    @staticmethod
    def _message(payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("model response is not an object")
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("model response contains no choices")
        message = choices[0].get("message")
        if not isinstance(message, dict):
            raise ValueError("model response contains no message")
        return message

    @staticmethod
    def _decode_json_content(message: dict[str, Any]) -> dict[str, Any]:
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("model response contains no JSON content")
        decoded = json.loads(content)
        if not isinstance(decoded, dict):
            raise ValueError("entity resolution must be an object")
        return decoded

    @staticmethod
    def _parse_mcp_result(body: str) -> str:
        candidates = [body.strip()]
        candidates.extend(
            line[6:].strip() for line in body.splitlines() if line.startswith("data: ")
        )
        for candidate in candidates:
            if not candidate.startswith("{"):
                continue
            try:
                payload = json.loads(candidate)
            except ValueError:
                continue
            result = payload.get("result") if isinstance(payload, dict) else None
            content = result.get("content") if isinstance(result, dict) else None
            if not isinstance(content, list):
                continue
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    return item["text"]
        raise ValueError("web search returned no text")

    def _web_search(self, client: httpx.Client, query: str) -> str:
        response = client.post(
            WEB_SEARCH_MCP_URL,
            headers={"Accept": "application/json, text/event-stream"},
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "web_search_exa",
                    "arguments": {
                        "query": query,
                        "type": "fast",
                        "numResults": 6,
                        "livecrawl": "fallback",
                        "contextMaxCharacters": 12_000,
                    },
                },
            },
        )
        response.raise_for_status()
        return self._parse_mcp_result(response.text)

    @staticmethod
    def _tool_definition() -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": "websearch",
                "description": (
                    "Search the public web for current company identity, ticker, "
                    "exchange, and share-class information."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "A focused web search query.",
                        }
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
            },
        }

    def resolve(self, query: str) -> WebEntityResolution | None:
        """Return a web-grounded proposal, or ``None`` on any optional-path failure."""

        normalized = " ".join(query.strip().split())
        if len(normalized) < 2:
            return None
        try:
            provider = self.provider_factory("taxonomy")
        except ProviderRuntimeError:
            return None
        if getattr(provider, "name", "") not in {"opencode", "deepseek"} or getattr(
            provider, "fake", False
        ):
            return None
        api_key = getattr(provider, "api_key", "")
        base_url = str(getattr(provider, "base_url", "")).rstrip("/")
        request_model = str(getattr(provider, "model", ""))
        if not api_key or not base_url or not request_model:
            return None

        system = (
            "Resolve a user's colloquial company name to the corresponding publicly "
            "traded US equity ticker or tickers. You must call websearch exactly once "
            "before answering. Do not guess and do not treat brands as legal issuer "
            "names without web evidence. Return one JSON object with keys: resolved "
            "(boolean), companyName (string), searchQueries (array of up to four ticker "
            "symbols), and evidenceUrls (array of source URLs). Include multiple ticker "
            "symbols only for genuine listed share classes."
        )
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": normalized},
        ]
        first_request = {
            "model": request_model,
            "messages": messages,
            "tools": [self._tool_definition()],
            "tool_choice": "required",
            "thinking": {"type": "disabled"},
            "temperature": 0,
            "max_tokens": 1_200,
        }

        client = self._http or httpx.Client(timeout=self.timeout)
        owns_client = self._http is None
        try:
            first = client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=first_request,
            )
            first.raise_for_status()
            first_payload = first.json()
            assistant = self._message(first_payload)
            tool_calls = assistant.get("tool_calls")
            if not isinstance(tool_calls, list) or len(tool_calls) != 1:
                return None
            tool_call = tool_calls[0]
            function = tool_call.get("function") if isinstance(tool_call, dict) else None
            if not isinstance(function, dict) or function.get("name") != "websearch":
                return None
            arguments = function.get("arguments")
            if not isinstance(arguments, str):
                return None
            parsed_arguments = json.loads(arguments)
            tool_query = parsed_arguments.get("query")
            if not isinstance(tool_query, str) or not tool_query.strip():
                return None
            web_result = self._web_search(client, tool_query.strip()[:300])
            tool_call_id = tool_call.get("id")
            if not isinstance(tool_call_id, str) or not tool_call_id:
                return None

            final_messages = [
                *messages,
                assistant,
                {
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": web_result[:20_000],
                },
            ]
            final = client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": request_model,
                    "messages": final_messages,
                    "tools": [self._tool_definition()],
                    "tool_choice": "none",
                    "response_format": {"type": "json_object"},
                    "thinking": {"type": "disabled"},
                    "temperature": 0,
                    "max_tokens": 1_200,
                },
            )
            final.raise_for_status()
            final_payload = final.json()
            decoded = self._decode_json_content(self._message(final_payload))
            if decoded.get("resolved") is not True:
                return None
            raw_queries = decoded.get("searchQueries")
            if not isinstance(raw_queries, list):
                return None
            search_queries: list[str] = []
            for value in raw_queries[:4]:
                ticker = str(value).strip().upper()
                if TICKER_PATTERN.fullmatch(ticker) and ticker not in search_queries:
                    search_queries.append(ticker)
            if not search_queries:
                return None
            evidence = decoded.get("evidenceUrls")
            evidence_urls = (
                tuple(
                    value.strip()
                    for value in evidence[:8]
                    if isinstance(value, str) and value.strip().startswith(("https://", "http://"))
                )
                if isinstance(evidence, list)
                else ()
            )
            company_name = str(decoded.get("companyName") or normalized).strip()[:200]
            provider_model = str(final_payload.get("model") or request_model)[:100]
            return WebEntityResolution(
                company_name=company_name or normalized,
                search_queries=tuple(search_queries),
                evidence_urls=evidence_urls,
                provider_model=provider_model,
            )
        except (httpx.HTTPError, TypeError, ValueError):
            return None
        finally:
            if owns_client:
                client.close()


__all__ = ["WEB_SEARCH_MCP_URL", "OpenCodeWebSearchResolver", "WebEntityResolution"]
