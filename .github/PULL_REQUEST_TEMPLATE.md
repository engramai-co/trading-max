## What does this change?

Describe the user-visible or operational outcome.

## Why?

Link the issue/RFC and explain alternatives considered.

## Verification

- [ ] Release scope follows `CONTRIBUTING.md`: product changes advance `VERSION`
      exactly once; ordinary documentation, metadata, CI, and test changes preserve it
- [ ] Every Python, npm, lockfile, and OpenAPI version surface matches `VERSION`
- [ ] Releases have a dated `CHANGELOG.md` section; an approved same-version
      `hotfix:no-release` change has categorized `Unreleased` notes
- [ ] Backend tests and Ruff pass where applicable
- [ ] Frontend lint, types, tests, and build pass where applicable
- [ ] OpenAPI/generated types are updated
- [ ] Migration, backup, privacy, and rollback impact was considered
- [ ] Documentation is updated where behavior or operation changed
- [ ] No real portfolio data, credentials, logs, screenshots, or generated
      artifacts are included

## Compatibility

Describe any API, database, configuration, deployment, or user-data impact.
