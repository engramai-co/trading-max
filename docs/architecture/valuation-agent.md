# Valuation agent evidence

The valuation evidence contract gives Python callers access to local public research. Its
five functions read and calculate on a frozen publication. The [Research Desk](valuation-model.md) still owns its own
default assumptions, broker mark preference, and explicit journal flow.

Trusted server code selects the workspace and its local readers, the exact
ticker and listing, an immutable snapshot run, an observation cutoff, and the
permitted metrics. It then freezes the evidence and creates a
`ValuationEvidenceTools` instance for a single call batch. No caller supplies
a workspace, listing, run ID, path, URL, query, or field name to the tools.

| Tool | Reads or computes |
| --- | --- |
| `get_valuation_basis` | Public quote, listing shares or reviewed receipt basis, FX, chosen statement period, and the selected family’s earnings, cash or common equity. |
| `get_operating_evidence` | Recent annual and quarterly statements plus the latest TTM, with period identity. |
| `get_expectations_and_changes` | Revenue consensus with a fiscal end and observation time; archived EPS revisions only between observations for the same listing, fiscal end, and currency. |
| `get_market_references` | Vendor multiples, analyst target, and the public cost-of-equity proxy. Vendor multiples and targets are context. |
| `evaluate_valuation` | Bear, base, and bull worksheets, terminal contribution, 25 sensitivity cells, and bounded reverse reading for five or ten years. |

Rows include a stable content ID, listing and metric, basis, fiscal period,
currency and unit, source and logical locator, publication and observation
times, source version, and quality. Date-only sources keep that precision,
and unknown times remain null. A retained row
keeps its original observation time. Restatements create new evidence in a new
capture; the pinned copy stays replayable. Observations and known publication
times cannot come from after the bound snapshot and cutoff. Forecast period
ends can be in the future. The existing archive tracks EPS; historical revenue
consensus revisions and vendor EPS without identified currency stay missing.

Evaluation takes bounded numeric assumptions and optional evidence IDs. IDs
resolve only in the frozen catalog; unknown, unavailable, duplicate, or
incompatible citations fail validation. The bundle is limited to 96 rows and
64 KiB. A call batch permits up to 16 responses, 192 total rows including
worksheet rows, and 64 KiB of response JSON. Excess requests fail explicitly.
Capture uses named public research artifacts and an optional bounded,
parameterized SELECT on the existing estimate archive. For snapshots that
predate share-unit publication it may read the pinned reference catalog
to resolve the exact ticker’s public security type. The tools themselves
hold only the frozen data; they have no database, network, broker, or journal
handle.

The evaluator shares the desk's versioned statement forecast. Frozen evidence
binds a family before the caller supplies scenarios. The family selects cash
flow, earnings, or common book and residual income. A residual-income basis
uses common earnings and book for the same period regardless of reported revenue. Its terminal contribution uses the full discounted exit price.
Model draft clients can compare this evaluation with the explicit
`/v2/research/{ticker}/valuation-preview` contract. Missing cash is disclosed
when a cash-flow scenario requires financing. Reported zero revenue in a cash-flow or net-income model produces
a reverse reading without a scenario range. The public quote remains the
only spot available to these tools. The same frozen evidence, formula and
proposed scenarios reproduce the worksheets. Tests compare annual worksheet
fields with the desk at relative and absolute tolerances of `1e-12` for the
same public quote. The [valuation model](valuation-model.md) specifies period
fallbacks, supported receipt ratios, FX and the financial gates.

## Drafting in Research

The editor starts a draft with an authenticated POST to
`/v1/research/{ticker}/valuation-draft`. It sends its current inputs for a local
record of the changes. The provider sees the listing’s frozen public evidence,
template candidates and, when enabled in Settings, numeric saved assumptions.
Broker prices, positions, notes and unsaved edits stay local.

Each template candidate points to a frozen record of the sector parameters,
dated public inputs and scenario values. Shared saved candidates point to
their numeric configuration or saved model version. Reported and derived
candidates cite the public rows used for their value.

The model selects candidates for individual scenario fields. The server
validates each selection against the candidates returned in that run and runs
the public evaluator. The sixth tool can only defer the evaluated proposal to
the editor. A run has 90 seconds, six tool calls, a 64 KiB evidence budget and
an 80,000-token cap. The stream reports which source is being read. A closed
request cancels the run. Each workspace permits one draft run at a time.

The latest sixteen completed pending drafts are private files in the workspace.
An accepted field enters the ordinary deterministic desk preview, which can
use the desk’s local broker mark. Only Save model version writes a journal
version. Saving checks the actual desk basis and latest parent under the same
lock as a manual save. The immutable version retains the reviewed decisions,
original values, frozen evidence, formula, prompt version and computed result.
A successful write frees the pending slot. An identical retry returns the saved
version from the journal. Discarding a draft restores the values it replaced.
When a newer basis arrives, re-review carries manual edits onto the new inputs. Drafts never select an overview
baseline.
