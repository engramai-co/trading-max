# Research workspace

The 1.x workspace organizes real provider data into independent research lenses,
keeping broker ingestion and portfolio snapshots separate. See the
[user guide](../guides/research.md) for the workflow and the
[presentation contract](research-presentation.md) for chart responsibilities.

## Decisions

- Normalize financial periods and metric observations before presentation.
  Preserve provider fields and immutable snapshots; a financial metric is not
  interchangeable with an estimate, a model assumption, or a differently dated
  provider summary.
- Use one quote identity throughout each loaded research context. Keep saved
  valuations frozen, and make recalculation a separate preview operation.
- Organize research around company facts, financials, price, expectations,
  valuation, and evidence. Keep the options workspace available where supported.
- Add public disclosure evidence and real market datasets through backend
  adapters. Missing data never becomes synthetic market data. The preview may
  mock Trading 212 account ingestion only.
- Retain working statement, margin, earnings-surprise, revision and options
  views. Extend their periods, drill-through and context instead of duplicating
  them. Match each visualization to the question being answered.

## Compatibility and alternatives

New response fields and endpoints are additive. Old lens URLs continue to work;
the account snapshot contract and NAV collection schedule do not change.
Legacy artifacts remain readable and are normalized without overwriting them.
Directly copying competitor values, scraping paid datasets, rebuilding research
inside the broker snapshot, and replacing all charts with one chart type were
rejected: each loses either provenance, compatibility, or useful meaning.

## Privacy and migration

Provider caches, filings, portfolios, watchlists, notes and model runs remain in
the external state root. Private evidence is excluded from shareable URL state.
No credentials or real-account data belong in fixtures or Git. Existing preview
state is preserved and an isolated build is verified before changing its launcher.
Published releases preserve additive contracts and existing external state.
Operator-managed macOS upgrades retain the previous installed runtime for rollback.
New model versions and notes share one atomic journal store. Saving a research
model does not rewrite the older background valuation-assumption configuration.
The latest saved research inputs initialize the next preview, while the saved
quote, financial observations, growth references and worksheet remain frozen.

## Validation

Synthetic domain tests cover period identity, cash-flow reconciliation,
currency conversion, sparse data and model reproducibility. API and UI checks
cover partial failures, research state, charts, keyboard and narrow viewports.
Repository checks run before the final local deployment. An issue is not closed
because a component exists: its stated data and interaction acceptance must pass.
