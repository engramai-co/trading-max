# Native model transport and ChatGPT device login

Pydantic AI 2.68.0 handles all model requests. Its native models and provider
SDKs use OpenAI Responses, ChatGPT Codex Responses, Anthropic Messages, Gemini
streaming GenerateContent, and Chat Completions for DeepSeek, OpenCode,
OpenRouter, Ollama and LM Studio. The same Python factory is used by
synthesis, security-name resolution, connection tests and the assistant. The
existing synthesis facade preserves its synchronous calls, prompts, tool
handoff, JSON validation and token accounting.

Research policy and validation stay in Trading Max. Legacy portfolio/ticker
narratives and automatic taxonomy remain disabled by default. Connecting a
provider does not enable them. The typed worker remains the single executor
of queued research. Existing artifacts are still read and reused: the cache
key includes the input, prompt version, provider and model, with no adapter
field. New results record `pydantic-ai` provenance; old results retain
`pi-ai`. The migration neither rewrites credentials nor requests a model.

Only the explicit saved provider and credentials are used. Remote endpoints
are pinned HTTPS origins and paths; local model connections require localhost
or 127.0.0.1 with a port. HTTP clients follow no redirects or environment
proxies. Model requests use SSE, limited by the caller's deadline. The
framework retries transient failures while opening the response, up to three
attempts, with a 10-second maximum retry delay. It does not replay an opened
stream. Connection tests use one attempt. Responses requests opt out of
storage and keep history in the local run. No prompt-cache retention or
session IDs are sent. Product errors use stable codes without upstream text.

## ChatGPT device login

The Node helper forks only when a user starts device-code login. Pydantic AI's
Codex OAuth login uses a localhost callback; the existing Pi AI 0.86.1
device-code flow also works when the server and the browser run on different
machines. The server requests and polls the device code in a bounded child
process. The browser opens OpenAI's verification page. A server restart or
connection cancellation ends the session; late results cannot save.

Access and refresh tokens stay under the existing `openai-codex:default`
credential-store reference. The Python credential source loads and saves the
same JSON fields (`type`, `access`, `refresh`, `accountId`, `expires`).
Pydantic AI performs refresh when the token expires. Its read, refresh grant
and save are serialized by the same file lock the API uses for sign-in and
disconnect. A waiting worker re-reads the store under that lock and adopts
the rotated credential before inference. Refresh grants are never retried,
followed to another URL or initiated in response to an inference 401. The
helper does not read Codex CLI credentials. ChatGPT subscription usage
remains distinct from Platform API usage.

Install the pinned login package with `npm run oauth:install` (Node >=22.19).
The wheels retain the scripts and npm lock, with no `node_modules`. Install
those dependencies in the installed `trading_max/synthesis/_pi` directory if
you use device login from a package-only installation. Inference uses the
Python dependencies. A retained runtime can roll back without rewriting the
credential JSON or the historical analysis records.

## Verification and known wire differences

`backend/tests/unit/test_llm_transport_parity.py` drives the real Python
model/provider SDKs through an httpx2 mock transport. The committed
`backend/tests/fixtures/llm/pi_0_86_1.json` records requests and parsed results
captured from the removed Pi completion helper using its injected fetch.
The recorder can be run against a retained checkout at the previous revision
by setting `PI_COMPLETE` to that checkout's installed `complete.mjs`.
The fixtures cover schema and prompt JSON, the two-turn web search exchange,
the Settings test, model aliases, token usage, HTTP errors, timeouts, and
truncation. OpenRouter, Ollama and LM Studio had no old inference path;
separate fixtures check their current endpoint and authentication policy.
No credentials or network access are needed. `npm run test:llm` verifies the
remaining Node device-login steps.

The fixtures compare content and request settings, not SDK identity headers,
JSON key order or compression. For example, Codex's old zstd request body and
the Python SDK's uncompressed JSON represent the same request. The harness
normalizes equivalent single text blocks and text strings in OpenAI and
Anthropic, Gemini's snake/camel case aliases and explicit text modality,
and omitted versus false strict sampling on Chat Completions. Claude Fable
omits Pi's deferred placeholder tool and duplicate per-message effort marker;
the effective request-wide effort and thinking settings match. Gemini
preserves a provider-issued thought signature across the tool loop; the
native SDK uses the standard placeholder signature when none is supplied.

For GPT-5.6 the old SDK emitted `prompt_cache_options: {mode: "explicit"}`
even with `cacheRetention: "none"`. Python omits this hint in accordance with
the cache policy. Neither path sends retention or a session/cache key in the
captured requests. The new code preserves the request deadline and attempt
limit; exact retry timestamps and SDK retry-header parsing are not a contract.
