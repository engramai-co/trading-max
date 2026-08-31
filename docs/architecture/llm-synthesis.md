# LLM synthesis boundary

The canonical provider contracts live under
`backend/src/trading_max/synthesis/`.

Every provider returns the same `SynthesisResponse` and is revalidated by the
same Pydantic schema. The response stores bilingual text, evidence references,
counterpoints, risks, invalidation conditions, next observations, confidence,
and taxonomy assignments. Provider metadata records provider, route, adapter,
model, provider configuration revision, route-policy revision, usage, latency,
timestamp, and whether the result is fake.

Prompt version `v4` gives each output section one job: the headline and summary
carry the conclusion, evidence carries atomic source-bound facts, counterpoints
challenge the conclusion, risks describe live failure modes, invalidation states
observable change conditions, and next observations list what to monitor. The
artifact boundary also removes exact bilingual duplicates and caps unbounded
audit lists, so provider wording drift cannot turn one observation into five
copies in the UI.

`FakeProvider` is deterministic and is the default for offline smoke tests.
`OpenAIResponsesProvider` uses `store=false` and strict JSON schema output.
`OpenCodeProvider` and `DeepSeekProvider` use the same OpenAI-compatible
chat-completions adapter with `response_format=json_object`, disabled thinking
for Flash smoke runs, bounded retries, and response validation. API keys are
only passed in Authorization headers; normalized provider errors do not include
request headers, response bodies, or response secrets.

The API-compatible analysis response remains unchanged.
`TypedAnalysisManager` persists analysis runs as SQLite jobs with the
`synthesis.llm` worker stage. There is no in-process analysis executor or
feature flag: API requests only admit a run, and the dedicated typed worker
executes it.

The durable path has coverage for both an embedded test worker and the normal
refresh worker registry. It preserves non-blocking analysis, snapshot-bound
inputs, force/cache semantics, and the existing frontend polling contract.
