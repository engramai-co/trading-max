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
The network providers are compatibility constructors around `PiProvider`.
Only `@earendil-works/pi-ai` handles model HTTP requests, message conversion,
stream parsing and bounded network retries. The Python worker invokes a
short-lived Node child over stdin/stdout; it adds no server or agent runtime.
OpenAI retains `store=false` and strict JSON schema; DeepSeek/OpenCode retain
JSON-object mode and Pi's provider-specific thinking behavior. The existing
Pydantic response validation still rejects invalid or truncated research.
Invalid domain output fails once rather than spending more requests in a second
application retry loop. Keys/context use stdin, not process arguments, ambient
credentials, files or logs. Upstream errors return only stable error codes.

Settings connectivity checks, taxonomy judgments and the existing bounded
security-name lookup use this same Pi boundary. Saved provider/model assignments
use OpenAI / gpt-5.4-mini by default. First-time AI settings offer OpenAI,
Anthropic and Google, and saving can set the selected model as the shared
default. Legacy DeepSeek/OpenCode defaults are retired by migration 0019.
There is no automatic cross-provider fallback. The settings registry limits the providers approved to
receive account data; importing the SDK does not enable all its providers.

Install the pinned SDK with `npm run llm:install` (Node >=22.19). Local onboarding,
foreground start and the Mac mini release builder include this step. Verify with
`npm run test:llm`; synthetic transport tests exercise the real Pi SDK without
paid provider requests. Backend wheels retain `_pi` scripts and npm locks, but
not `node_modules`; a package-only install must run `npm ci --ignore-scripts`
in the installed `trading_max/synthesis/_pi` directory before model use.
See [transport decision](pi-ai-transport.md) for compatibility and rollback.

The API-compatible analysis response remains unchanged.
`TypedAnalysisManager` persists analysis runs as SQLite jobs with the
`synthesis.llm` worker stage. There is no in-process analysis executor or
feature flag: API requests only admit a run, and the dedicated typed worker
executes it.

The durable path has coverage for both an embedded test worker and the normal
refresh worker registry. It preserves non-blocking analysis, snapshot-bound
inputs, force/cache semantics, and the existing frontend polling contract.
