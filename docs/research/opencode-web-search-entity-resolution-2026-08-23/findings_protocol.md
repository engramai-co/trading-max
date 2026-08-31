# Protocol findings

## Decision

Trading Max will not add a Security Master/RAG resolver for free-text company
queries. The fallback is one OpenCode Go model turn with a single `websearch`
function available, followed by one bounded tool-result turn. The model proposes
one or more public ticker symbols; existing market-identity lookup validates
those symbols before anything is shown or persisted.

## Verified behavior

- OpenCode Go exposes an OpenAI-compatible chat-completions endpoint at
  `https://opencode.ai/zen/go/v1/chat/completions` and currently publishes the
  request model alias `deepseek-v4-flash` through its unauthenticated `/models`
  endpoint. A provider response may identify an underlying dated model build;
  request routing must use the provider's published alias.
- OpenCode's built-in tool is named `websearch`. It is available for the
  OpenCode provider and uses a hosted search MCP without requiring a separate
  user API key.
- OpenCode implements the Exa path as one JSON-RPC `tools/call` request to
  `https://mcp.exa.ai/mcp`, with tool name `web_search_exa` and bounded query,
  result-count, crawl-mode, and context-size arguments.
- Direct chat-completions requests still follow the standard tool-call loop:
  the model requests a function, the caller executes it, then returns the tool
  result for the final structured answer. Trading Max therefore owns the
  execution boundary and can expose only web search, not filesystem or shell
  tools.

## Primary sources

- https://dev.opencode.ai/docs/go/
- https://dev.opencode.ai/docs/tools/
- https://dev.opencode.ai/docs/server/
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/websearch.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/mcp-websearch.ts
- https://api-docs.deepseek.com/guides/tool_calls
