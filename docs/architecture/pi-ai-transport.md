# Pi AI transport consolidation

Status: implementation, based on product 1.7.4; not a production deployment.

## Decision

Use only `@earendil-works/pi-ai` 0.86.1 for model requests. Do not add an agent
runtime, autonomous tool loop, session store, or new service. Existing workload
assignments, prompts, immutable research context, credentials and result
validation remain Trading Max responsibilities. New settings default to
OpenAI / gpt-5.4-mini. An unconfigured AI settings page opens a dismissible
provider picker, preselecting OpenAI, with Anthropic and Google as alternatives.
Users test their key before saving and can make that choice the default for
all workloads without an explicit override.

The Python worker calls a short-lived Node process over stdin/stdout. Node 22 is
already a product dependency; Pi requires 22.19 or newer. The bridge uses Pi's
provider factories, model metadata, message conversion, streaming parser, usage
accounting and network retry policy. It contains no HTTP model implementation.
The existing bounded security-name lookup still makes two model calls and one
web search; Pi does not execute tools or decide additional work.

Alternatives: keeping handwritten HTTP duplicates provider behavior across
synthesis, settings, taxonomy and entity resolution. A long-running gateway
adds a service, authentication and availability boundary. Rewriting the Python
worker in TypeScript is unnecessary for this bounded simplification.

## Compatibility and privacy

Keep provider identity, historical results and OS credential storage. Keys
and research context travel through the child process's stdin, never command
arguments, temporary files or logs. Pi gets an explicit key, no ambient
credential store, and no redirects. The child exits after one response and has
a bounded timeout. Errors crossing back into Python are stable codes without
upstream response text. JSON mode/strict Responses schema are small Pi payload
options; Pydantic remains the authority for accepted financial research output.

Migration 0019 adds Anthropic/Google metadata support without losing existing
integration records. At the product owner’s request, legacy DeepSeek/OpenCode
defaults move to OpenAI, their workload overrides are removed and their saved
integrations are disabled. Keys are retained, never exported or deleted.
Explicit routes for other providers remain intact. Runtime uses only the
selected route; a missing key never triggers a different provider. The old
provider API remains compatible for existing clients but is absent from the
new connection picker. No model call is made by the migration.

Install the locked bridge dependencies as part
of setup/release, before running a model job. Missing runtime dependencies fail
clearly rather than silently using the old HTTP implementation. Fake-provider
tests remain offline. Rollback restores the previous source/dependencies and the pre-upgrade database
backup together. Migration 0019 changes the active default route, so rolling
back code alone does not restore the previous routing policy.

## Verification

Exercise the real Pi SDK against synthetic transport responses: OpenAI Responses
Anthropic Messages, Google Generative AI and legacy Chat Completions, JSON/schema options, tools, usage, auth
errors, retry, malformed output and timeout. Test the Python boundary, process
cleanup, secret-safe errors, model assignments and existing workflow behavior.
No paid completion or production mutation is needed for contract validation.

Source: [Pi AI package](https://github.com/earendil-works/pi/tree/main/packages/ai).
The npm lock pins the published artifact, rather than tracking upstream main.
