# Agent runtime

The read-only assistant runtime shipped in 1.50.0.

## Decision

Agent infrastructure comes from open-source frameworks. Trading Max writes only
what no framework can: the tools that read its own data, the per-run binding of
model, snapshot and limits, and configuration.

| Concern | Provided by |
| --- | --- |
| Agent loop, tool calls, retries, limits, cancellation | Pydantic AI `Agent`, `FunctionToolset`, `UsageLimits` |
| Model requests for every provider | Pydantic AI native models, through `trading_max.llm` |
| Stream to the browser | Pydantic AI `VercelAIAdapter` (AI SDK UI message stream, SDK 6) |
| Conversation history | Pydantic AI `ConversationStore`; a SQLite backend implements its five storage primitives |
| Approval before a write (future tools) | Pydantic AI deferred tools, carried by the same stream and store |

`trading_max.llm` is shared with research synthesis; see
[LLM synthesis](llm-synthesis.md). Pi remains only for the ChatGPT device-code
login, because Pydantic AI's ChatGPT/Codex sign-in supports only a redirect to
the server's own localhost. Token refresh and requests use Pydantic AI.

Alternatives considered on 2026-11-15: the hosted OpenAI Agents API (OpenAI
models only, US data residency only, no Zero Data Retention, sessions kept until
deleted, tracing on by default); `pi-agent-core` in a Node process (run state
split across two runtimes); and a Pydantic AI loop with a Pi model bridge, which
required a self-maintained Python-to-Node protocol.

## Providers

`openai`, `openai-codex` (ChatGPT sign-in), `anthropic`, `google`,
`deepseek`, `opencode`, `openrouter`, and the local `ollama` and `lmstudio`
servers. Credentials come only from the operating-system credential store;
providers never fall back to environment variables or other applications' files.
Remote providers use their HTTPS registry URL. Local providers accept only an
`http(s)://127.0.0.1:<port>` or `http(s)://localhost:<port>` base URL, and an
API key is optional for them. Redirects are refused. There is no automatic
fallback to another provider.

## Runs

- One run answers one user turn: at most 8 model requests, 12 tool calls and
  400,000 tokens, 8,192 output tokens per request, a 20-second limit per tool
  call and 300 seconds overall. A follow-up or regenerated turn starts with
  fresh limits. The conversation record keeps lifetime usage and the run log
  counts only the completed turn.
- A run reads one pinned snapshot. Tools refuse account scopes outside the run's
  allowed scopes; the model cannot widen them.
- History is held on the server. The client sends only its new turn; a
  regenerate or edit keeps the replaced turn as a branch. A run that fails or is
  stopped is not saved. Closing the browser request cancels the run.
- The web app sends what the page shows (page, account scope, range, ticker and
  research view) beside the AI SDK fields. Each value is checked against an
  allowlist and only then reaches the model as context.
- One conversation runs one turn at a time, and at most two turns run at once;
  a busy request gets `assistant_busy` before any model call.
- Each finished run logs its status, duration, model and token and tool counts;
  never the question, the answer or tool data.
- Failures reach the client as stable codes, never upstream error text.

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/assistant/chat?page=&tz=` | Run a turn; AI SDK UI message stream. Requires the write token. |
| GET | `/v1/assistant/status` | Whether a turn could start now, and why not, without calling the model. |
| GET, DELETE | `/v1/assistant/conversations` | List recent conversations or delete all conversations and messages in the workspace. |
| GET | `/v1/assistant/conversations/{id}` | One conversation as AI SDK UI messages. |
| DELETE | `/v1/assistant/conversations/{id}` | Delete a conversation and its messages. |
| GET, PUT | `/v1/settings/assistant` | Enablement, route, reasoning effort, consent, background briefs and sharing saved valuation assumptions. |

The web app proxies assistant and settings routes under `/api/backend`.
The chat route passes the stream through without buffering or compression.

The saved-model test in Settings requires an enabled assistant and current
consent for that model and endpoint. It makes a small exchange in which the
model must call a tool. Models that only return text fail it with
`assistant_tools_unsupported`, rather than failing later on every question.

## Period calculations

The assistant answers period P&L, drawdown, period returns and benchmark
questions from `trading_max.portfolio_math`, a Python port of
`apps/web/lib/portfolio`. Fixtures generated from the TypeScript keep the two in
agreement; the web test suite fails when they drift.

The following GET readings are independent of the model connection. Each uses
the published snapshot named in `/v1/snapshots/{run_id}/insights/` and returns
the same evidence ID and figures as its assistant tool. Paginated readings
return up to 20 rows per call.

| Reading | Tool | Calculation |
| --- | --- | --- |
| `daily-returns` | `daily_returns` | Published daily TWR, or the change between consecutive wealth observations for legacy exports, ranked lowest first within the Returns chart’s calendar cut. Undefined intervals stay outside the sample. Returns equal at the twelve-decimal publication precision share a rank. The selected benchmark defaults to VOO. The interval endpoints are observations of the selected account scope. Benchmark changes require both closes. A custom range takes inclusive start and end dates. CFD and household have no TWR. |
| `holding-fx` | `holding_fx_split` | Invest and Stocks ISA position and account amounts in GBP. The 1D and 5D readings use the Holdings contribution windows. Open-position FX matches the holdings table and drawer. |
| `dated-exposure` | `dated_exposure` | Combined broker country, sector, GICS sub-industry or top-40 company exposure on or before the requested date. The response gives the actual observation date and earliest retained date. |
| `decision-timing` | `decision_timing_and_habits` | Rule-based buy and sell counts, scored effects, and hindsight timing for each published decision. Habits use the selected horizon for the whole group and open at 20 sessions. A focused account, ticker, decision date and side opens to date if its 20-session window is incomplete. |
| `key-moments` | `price_key_moments` | At most three unusual days with reported earnings, a rating action, a filing or an in-scope trade in the visible range. Events identify records for inspection. They do not establish causation. |

The FX split uses the shares held at both ends of each measured segment. The
local price effect converts the change in the native quote at the closing GBP
rate. The FX effect is the remaining held-share contribution, including the
revaluation of the opening exposure. The 5D reading sums the rounded daily
segments for each broker listing. Executed buys and sells reconcile changes in
quantity. Paired split transactions translate the opening quantity and price into
closing units. An unchanged sterling cost and reciprocal change in native purchase
price and share count can also reconcile them. Unreconciled units withhold that
listing and its account subtotal. Daily attribution must match the current broker
observation. Cash, trading within a segment and changes
in share count stay outside the split. Since acquisition, the broker's own FX
figure takes precedence. When it is absent, the native average price paid and
closing value give the local price effect and the rest of unrealised P&L is
FX. Sterling and pence positions have zero currency effect. A missing FX
input withholds the split and the corresponding account subtotal.

Exposure history begins with the first complete publication containing a
dated look-through after installation of this feature. Each London date
pins its first available broker composition to the original immutable look-through
artifact. Later refreshes that day reuse the pin. The latest snapshot carries 35
calendar days plus the last observed date in each of the past 60 months.
Historical snapshots and backups keep their own pins. Dated keys reuse the
published bytes, preserving the invested-asset denominator, eligible-equity and
portfolio GICS coverage and each row's classification status. Current and dated
readings use the same classification coverage.
A month without a refresh has no invented month-end observation.

Hindsight compares the decision's close with other completed closes in the
same window, on the review's split-adjusted GBP basis. A delayed buy holds
cash until entry and earns dividends after entry. A delayed sale receives
dividends while it still holds the shares. The missed amount scales the
difference in outcomes by that security's mean GBP purchase order size in the same
account through the decision date. A missing purchase basis withholds the sizing. A pending price or dividend withholds
the timing comparison. Unobserved decisions contribute to the count of
decisions and stay outside the scored denominator.

Key moments use daily bars and the previous visible close. Volume z-scores
compare with the preceding 20 published sessions using population standard
deviation. A missing or constant reference window has no volume score.
Absolute moves and absolute volume z-scores rank separately across all
visible days. Among dates with evidence, the better rank wins, with the
earlier date breaking a tie. The chart and reading resolve the same requested
listing, including exchange-qualified watchlist aliases. A run captures its
aliases at the start and reads prices and events from its pinned snapshot. The series carries a
`publishedSeriesId` bound to the price artifact and ticker. A chart caller
passes it as `published_series_id` so a newer publication cannot be
mistaken for the chart on screen. Live or differently sampled charts
have no matching published daily series identifier.

## Privacy

The assistant is off until the user enables it and accepts the current consent
revision. Settings names the recipient and asks for consent again when the
provider or local endpoint changes. Turning the assistant off or withdrawing
consent cancels active turns. Every outgoing provider request, including each
retry, checks the bound preferences and integration against the workspace.
Chats and saved-model tests share a cancellation token for the selected
connection. Changing that connection advances its persisted revision. Queued
requests check the revision before sending HTTP headers and again before sending
the body. A saved API key must match the integration's recorded fingerprint.
Clients granting consent to a local model must send the endpoint shown to the
user in `expectedConsentDestination`. A changed endpoint returns a conflict.
Turning the assistant off retains consent. Both actions keep conversations
available for separate deletion.
Background writing and sharing saved valuation assumptions each have a
default-on preference. Both require enablement and current consent.

The selected provider receives tool results, not raw stores, limited
to what the question needs. Conversations stay in the workspace database;
deleting one removes its messages there, though backups taken earlier keep
their copy. Pydantic AI instrumentation stays off and no vendor tracing is used.

## Evaluation

[The evaluation runner](../../tools/evaluate_assistant.py) exercises the same
assistant, toolset, and usage limits over a temporary synthetic snapshot. It
does not use your portfolio or conversation history. The 25 cases cover all
fifteen tools, English and Chinese, fixed earlier turns, missing and partial
data, requests for personal trades, stored prompt injection, and account scope
restrictions.

Run the offline regression suite with scripted models:

```bash
uv run pytest services/api/tests/test_assistant_evals.py
```

To measure a real model, explicitly choose both provider and model. Configure
the provider's credentials in Settings first. The runner reads the same OS
credential item as the app; it does not take keys on the command line or
read them from the environment. For `openai-codex`, set
`TRADING_MAX_DATA_ROOT` to the configured workspace outside the repository so
token refresh uses the app's shared lock. For Ollama or LM Studio, a key is
optional and `--base-url` may specify a loopback endpoint.

```bash
uv run python tools/evaluate_assistant.py --provider openai --model gpt-5.6-luna \
  --reasoning low --cases invest-overview,benchmark-voo,stored-injection \
  --json /tmp/trading-max-eval.json
```

Omit `--cases` to run all cases. Add `--llm-judge` to send the synthetic
conversation and answer to the same provider for an extra qualitative check.
Default scoring is deterministic and makes no judge calls.

The report lists passing checks for each case and passing cases for each
evaluator, with time to first visible text, total turn time, provider token
counts, model requests, and tool calls. Turn metrics exclude judge time and
usage. The command exits nonzero if any check fails.
Reports contain scores and timings rather than prompts, answers, tool
payloads, credentials, or raw errors. `--json` takes a new path outside the
repository.

The checks require the expected calls, grounded and cited figures, the
question's language, no personal trade or position-size instruction, and no
run or tool errors or unknown token usage. Case-specific checks also require
key facts and disclosure of missing data, and check scope and injection
cases for leakage. Money and percentages with explicit units, including
units in table headers, must match a numeric tool field of the same unit and sign to within
half the last displayed digit (e.g. `£207,823.66` from `207823.657`,
`−12.19%` from `−0.12187`). Percentage fractions are converted to
percentage points before comparison. Figures need a matching `[ev_…]` in
their sentence or table row, and every evidence ID must come from this turn.
The deterministic language and advice checks are pattern based; they are
regression signals rather than a substitute for reviewing borderline answers.
