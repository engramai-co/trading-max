# Contributing

Thank you for improving Trading Max. Read [GOVERNANCE.md](GOVERNANCE.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating.

Open an issue before implementing a material feature, provider integration,
schema change, or deployment change. Small bug fixes and documentation
corrections may go directly to a pull request.

## Development setup

Requirements:

- Python 3.12 and uv;
- Node.js 22 LTS and npm;
- Git.

```bash
git clone https://github.com/engramai-co/trading-max.git
cd trading-max
uv sync --all-packages --group dev --frozen
npm --prefix apps/web ci --no-audit --no-fund
uv run pytest services/api/tests backend/tests
npm --prefix apps/web run build
```

Use a separate synthetic state root for manual development. Never point tests
or development commands at a production state directory.

## Before submitting a change

Every pull request is one releasable change. Before opening or updating it:

1. advance `VERSION` by exactly one SemVer increment;
2. align the Python packages, npm packages and locks, backend `__version__`,
   and generated OpenAPI version with `VERSION`;
3. promote the change into a dated `CHANGELOG.md` section for that version.

Use PATCH for compatible fixes and maintenance, MINOR for compatible features,
and MAJOR for breaking API, configuration, database, or deployment changes.
Documentation-only and dependency-only pull requests follow the same contract;
there are no unreleased lanes on `main`.

```bash
uv sync --all-packages --group dev --frozen
uv run ruff check backend services/api tools deploy/macos/configure-host.py deploy/local/install-macos-service.py
uv run ruff format --check backend services/api tools deploy/macos/configure-host.py deploy/local/install-macos-service.py
uv run pytest services/api/tests backend/tests
npm --prefix apps/web ci --no-audit --no-fund
npm --prefix apps/web run check:api-types
npm --prefix apps/web run check:architecture
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web test
npm --prefix apps/web run build
uv run python tools/generate_openapi.py --check
uv run python tools/check_repository_hygiene.py
uv run python tools/check_release_readiness.py
uv run python tools/check_documentation.py
uv run python tools/check_version_consistency.py
uv run python tools/check_changelog_entry.py --expected "$(tr -d '[:space:]' < VERSION)"
```

Public release maintainers additionally run:

```bash
uv run python tools/check_release_readiness.py --public
uv run python tools/check_public_history.py
```

Use synthetic fixtures only. Do not add Trading 212 exports, portfolio
snapshots, watchlists, SQLite files, Keychain exports, logs, generated charts,
real-account screenshots, cached company logos, or LLM outputs. Review the
staged path list before every commit.

Commit messages should be concise, imperative, and scoped to one outcome, for
example `fix: preserve bootstrap settings on repeat setup`.

Pull requests should explain compatibility, migration, privacy, backup, and
rollback implications where relevant. Maintainers aim to provide a first
response within 14 days.

By submitting a contribution, you agree that it may be distributed under the
project's [Apache License 2.0](LICENSE). Use GitHub Issues for public technical
discussion and follow [SECURITY.md](SECURITY.md) for private vulnerability
reports.

After protected `main` CI succeeds, the repository automatically creates an
annotated `vMAJOR.MINOR.PATCH` tag from the matching changelog notes and
dispatches the complete Release workflow. That workflow re-runs backend and
frontend validation, builds the source archive, checksum and SBOM, attests the
public source bundle, and publishes the GitHub Release. Do not create release
tags by hand during the normal contribution flow.
