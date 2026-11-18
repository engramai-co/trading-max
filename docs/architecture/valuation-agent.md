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

A draft uses the family from the desk’s v2 preview and records whether it
was selected automatically or by the reader. The desk and public evaluator
must agree on the statement period, listing shares, ordinary shares per
receipt and reporting-to-quote FX. A missing basis or withheld reverse
reading shows its reason in the editor and produces no proposal. A reading
outside the search bounds can still support a draft.

The model selects candidates for individual scenario fields. The editor
renders each reason from the candidate source and its typed evidence,
including the unit, period and observation time. The server
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
When a newer basis arrives, re-review carries manual edits onto the new
inputs. Drafts never select an overview baseline.

Previously saved models remain readable. Manual versions keep their existing
journal format. A reviewed version adds an audit record, so preserve the
workspace backup from before the first reviewed save for a downgrade.

## Reviewing new evidence

An editor opened from a saved version offers See new evidence. The editor posts
its current proposal to `/v2/research/{ticker}/valuation-maintenance` with the
saved model ID. The service replays the saved assumptions on four bases, in
this order, so the parts add up to the proposal exactly:

1. the saved version's own frozen basis;
2. the latest statements at the saved price and exchange rate (new financial base);
3. the current price and exchange rate (price and FX);
4. the proposed assumptions on the current basis (changed assumptions).

Every value comes from the desk's projection with the saved formula version
and the editor's horizon. Price changes a value only through financed
dilution; the exchange rate rescales statement amounts. When the reporting
currency changes, the rate moves with the statements. A different quote
currency withholds the comparison.

The saved period is compared with the current statements for the same
period. A changed figure is a restatement: the response lists it, and the
walk measures its effect within the new financial base. The share count is
compared when it came from the balance sheet. A quoted share count stays as
saved; a switch to the balance-sheet count belongs to the new financial base.
Each figure the statements still report is compared on its own. When one is
missing, the review lists the restatements it found, names the missing
figure and withholds their combined effect. A period that has left the
statements, or statements in another reporting currency, cannot be checked,
and the review says which. Conflicts are four quarters that differ from the
fiscal year ending on the same day by more than 0.5%, and provider rows that
disagree in the basis period, in the fiscal year it is checked against or in
a newer period the model skipped. Earnings follow the basis: common earnings
when reported, otherwise net income. The model uses the documented period and
never blends the two sources.

Fiscal-year EPS consensus at the save time comes from the estimate archive
and is compared with the latest observation for the same year end and
currency. Each version records the revenue-growth consensus it was saved
against, apart from the references its assumptions may inherit from an
earlier version. A version saved before that record is compared with its
consensus references or reviewed evidence. The comparison reads no provider,
contacts no model and writes nothing.

The reader can lock individual scenario assumptions. A locked field stays as
saved until the reader unlocks it, and versions record their locks. A
version without locks keeps the earlier journal format. Draft requests carry
the editor's locks: MaxAI receives no candidate for a locked field, and
saving rejects a record that proposes one. A draft from an editor opened
from a saved version is a maintenance run. It starts from the saved
assumptions when Settings allows them to be shared, otherwise from the
sector templates, and proposes only the fields the model selects. Its
record carries the prompt version `valuation-maintenance-v1`. Preserve the
workspace backup from before the first save with locks for a downgrade.

## Notices of new evidence

Notices of new evidence are off until the reader turns on the Notices switch
under Settings, Update schedule. With it on, `GET /v1/valuation/evidence-notices`
compares each security's newest saved version with the latest publication,
using the calculations behind See new evidence:

- statements that end after the saved period, which is how a new report
  arrives; an older or unreadable basis, as after an incomplete publication,
  is not announced;
- a restatement of the saved period;
- fiscal-year consensus that has moved by at least one step from the value
  recorded at the save: 5% of the saved EPS, or two percentage points of
  revenue growth. Each further step counts again.

Each piece of evidence has a stable key, and the comparison behind See new
evidence names the keys it shows. Opening it records those keys
(`POST /v1/valuation/evidence-notices/{ticker}/seen`), so the same report or move
is announced once, however many publications repeat it. Evidence that arrives
after a comparison was made stays announced until a comparison shows it. A
version saved afterwards starts without a notice. Company guidance has no
source in the research data; it shows through new statements and consensus
revisions. A security whose comparison cannot run has no notice. An open page
fetches its notices again when a new publication arrives.

A dot marks a notice in the research list, beside See new evidence and in the
journal's model versions. Notices are computed on request on this machine.
They never draft, contact a model or save a version, and the only state they
keep is the keys the reader has opened, in `evidence-notices.json` in the
workspace.

## The model saved for a decision

Review links a selected decision to the newest valuation version saved by the
end of its day (`GET /v1/research/{ticker}/models/as-of?day=`), and the link
opens that version in the journal. A decision's day is the broker's UTC trade
day, which has no time, so a version saved later that day is included.
