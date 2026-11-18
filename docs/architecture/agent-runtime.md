# Agent runtime

Status: foundation for the read-only assistant. Not released.

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
  call and 300 seconds overall.
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
| GET | `/v1/assistant/conversations` | Recent conversations with titles. |
| GET | `/v1/assistant/conversations/{id}` | One conversation as AI SDK UI messages. |
| DELETE | `/v1/assistant/conversations/{id}` | Delete a conversation and its messages. |
| GET, PUT | `/v1/settings/assistant` | Enablement, route, reasoning effort and consent. |

The web app proxies these under `/api/backend/assistant/`; the chat route passes
the stream through without buffering or compression.

The assistant connection test in Settings makes one small exchange in which the
model must call a tool. Models that only return text fail it with
`assistant_tools_unsupported`, rather than failing later on every question.

## Period calculations

The assistant answers period P&L, drawdown, period returns and benchmark
questions from `trading_max.portfolio_math`, a Python port of
`apps/web/lib/portfolio`. Fixtures generated from the TypeScript keep the two in
agreement; the web test suite fails when they drift.

## Privacy

The assistant is off until the user enables it and accepts the current consent
revision. The selected provider receives tool results, not raw stores, limited
to what the question needs. Conversations stay in the workspace database;
deleting one removes its messages there, though backups taken earlier keep
their copy. Pydantic AI instrumentation stays off and no vendor tracing is used.

## Evaluation

[The evaluation runner](../../tools/evaluate_assistant.py) exercises the same
assistant, toolset, and usage limits over a temporary synthetic snapshot. It
does not use your portfolio or conversation history. The 20 cases cover all
ten tools, English and Chinese, fixed earlier turns, missing and partial
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

## News and scheduled events

The read-only `news_and_events` tool returns dated headlines, earnings estimates
and reports, rating changes, filings, dividends and the permitted accounts'
broker trades. Each row identifies its evidence in the pinned publication.
A publisher's headline is a lead. It cannot establish the cause of a price move.

`upcoming_events` and `GET /v1/snapshots/{run_id}/events/upcoming` share the
same projection. Pass `scope`, inclusive ISO dates `start` and `end`, and an
optional exact listing ticker. The API accepts an IANA `timezone` (default
`Europe/London`), `cursor` and `limit`. The household calendar includes the
last scheduled research universe as well as holdings. Exchange calendars supply
holidays and early closes for identifiable listings. All-day dates stay on their
publisher's calendar day. Timed rows include the source instant and local time.
An earnings window retains both ends when the provider has not set a single day.

Scheduled research records Yahoo-compatible headline metadata with the shared
Yahoo request budget. Fresh disclosure observations are reused. The rolling
news history retains up to 500 headlines per listing for up to a year. Account
activity stays in the published local ledger. Official-calendar requests contain
no tickers or portfolio data. An unsuccessful refresh preserves the last
successful rows and their original observation time. Data status shows their
freshness and the number of failed sources.

### Official macro calendars

The local worker checks the following keyless release schedules at most once
per 20 hours for a 180-day window. Calendar rows carry the publisher, original
link, translated label, source credit and scheduling status. Coverage follows
the publisher's announced horizon. Individual announcements can change.

| Market | Sources |
| --- | --- |
| United States | BEA release iCalendar, Census indicator tables, Federal Reserve meeting and monthly announcements, BLS release schedules on the public FRED calendar (Central time) |
| United Kingdom | Office for National Statistics release calendar under the Open Government Licence v3.0, Bank of England MPC dates for personal and internal non-commercial use |
| Euro area | European Commission, Eurostat Euro indicators iCalendar (category 2, date only), European Central Bank Governing Council and statistical schedules |
| Japan | Statistics Bureau and METI via e-Stat, Cabinet Office GDP, Bank of Japan monetary policy meetings |
| Hong Kong | Census and Statistics Department, © Government of the Hong Kong SAR. Visible dates from its English press release index |
| South Korea | Ministry of Data and Statistics statistical timetable, Bank of Korea policy-setting meetings and its announced 2027 schedule until the HTML table rolls over |

Trading Max translates or abridges display labels. The publisher's original
schedule is authoritative. Eurostat bears no responsibility for translations.
Only calendar metadata and Yahoo-compatible headline metadata are stored.
