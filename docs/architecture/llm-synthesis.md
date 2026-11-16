# LLM synthesis boundary

Legacy synthesis is disabled by default. The current product uses its optional
model connection for security-name resolution and the assistant. API and worker require an
explicit `TRADING_MAX_LLM_ANALYSIS_ENABLED=true` to admit or execute synthesis,
including previously queued jobs. Account capture, performance and deterministic
research updates do not depend on that switch. Historical artifacts remain readable.

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
The synchronous research facade uses the native providers in
`trading_max.llm`. The factory supplies explicit credentials, confines
requests to approved endpoints, and uses streaming HTTP with bounded
framework retries. Settings connectivity checks, taxonomy judgments and
security-name lookup use the same factory. The assistant uses the native
models directly through its own bounded agent runtime.

OpenAI Responses retains `store=false` and strict JSON schema for synthesis.
DeepSeek and OpenCode keep JSON-object mode; Gemini JSON mode disables tool
declarations. The other providers keep the schema in the prompt. Pydantic
validates the resulting research, rejecting invalid or truncated output
without an additional model request. Upstream errors return only stable codes.

Saved provider/model assignments, Settings defaults and OS credential storage
are unchanged. ChatGPT sign-in uses the existing device-code flow, and Python
serializes token refresh across the API and worker. Subscription and API-key
connections are distinct. A missing key never triggers a different provider.
New synthesis artifacts record `pydantic-ai` as the adapter; historical
artifacts keep their original provenance and cache reuse is unchanged.

See the [transport decision and parity checks](pi-ai-transport.md) for protocol
details, privacy and rollback. The Python factory needs no Node child for
inference; `npm run oauth:install` installs the remaining device-login helper.

The API-compatible analysis response remains unchanged.
`TypedAnalysisManager` persists analysis runs as SQLite jobs with the
`synthesis.llm` worker stage. When explicitly enabled, API requests only admit a
run, and the dedicated typed worker executes it; there is no in-process executor.

The durable path has coverage for both an embedded test worker and the normal
refresh worker registry. It preserves non-blocking analysis, snapshot-bound
inputs, force/cache semantics, and the existing frontend polling contract.
