# OpenCode web-search entity-resolution research plan

## Main question

How should Trading Max resolve a natural-language company query such as `google`
by calling the existing OpenCode API model `ds-v4-flash-07-31` with a web-search
tool, without introducing a Security Master/RAG path?

## Subtopics

1. Verify the current official OpenCode model identifier and the exact request /
   response contract for tool calls, especially any built-in web-search tool.
2. Map that protocol onto Trading Max's current OpenCode provider and securities
   search flow, preserving deterministic validation and safe failure behavior.

## Synthesis

Implement the smallest typed resolver that lets DeepSeek request web search,
executes only that bounded tool, validates the returned ticker/company identity,
and falls back to the existing deterministic search when AI/tooling is unavailable.
