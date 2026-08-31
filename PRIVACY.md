# Privacy and local data

Trading Max is a self-hosted, single-user application. It does not operate a
Trading Max cloud account service and does not include product analytics or
advertising trackers.

## Data stored locally

The selected external state root may contain:

- broker account snapshots, positions, transactions, and derived performance;
- watchlists, research inputs, valuation assumptions, and alerts;
- immutable research and analysis artifacts;
- job state, health state, and application logs;
- a local SQLite database and backup archives.

Credentials are stored separately by the operating-system credential manager.
They are not included in Trading Max backups and are not returned to the
browser.

## Data sent to providers

Trading Max communicates only with providers the local user configures:

- Trading 212 receives its API credential and account-data requests;
- market-data and instrument-identity providers receive ticker, identifier, or
  issuer queries;
- OpenCode or DeepSeek receives the bounded portfolio or research context
  needed for an explicitly configured analysis route.

The fake LLM provider sends no data externally. The application does not send
the internal FastAPI token to any external provider.

Provider handling, retention, and training policies are controlled by those
providers and their terms. Users should not configure a provider unless its
terms are acceptable for their data.

## Retention, export, and deletion

Immutable snapshots and analysis artifacts are retained in the external state
root until the user removes them. Backup retention is configurable; the
packaged macOS service keeps the newest 14 archives by default.

To export data, stop Trading Max and create a verified backup with
`trading-max backup`. To delete all local product data, stop every Trading Max
process, preserve any required export, remove the external state root and
backup directory, and delete the relevant Trading Max entries from the native
credential manager.

Uninstalling the macOS LaunchAgents deliberately preserves state and backups.

## Logs and support

Application logs must not contain stored credential values. Before attaching a
log or support bundle to an issue, review it for portfolio values, account
identifiers, hostnames, filesystem paths, and provider responses. Never post a
credential or private financial snapshot to a public issue.

Security reports follow [SECURITY.md](SECURITY.md). General support follows
[SUPPORT.md](SUPPORT.md).
