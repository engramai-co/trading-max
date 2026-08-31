## What does this change?

Describe the user-visible or operational outcome.

## Why?

Link the issue/RFC and explain alternatives considered.

## Verification

- [ ] `VERSION` advances by exactly one PATCH, MINOR, or MAJOR increment
- [ ] Every Python, npm, lockfile, and OpenAPI version surface matches `VERSION`
- [ ] `CHANGELOG.md` starts with a dated section for the proposed version
- [ ] Backend tests and Ruff pass where applicable
- [ ] Frontend lint, types, tests, and build pass where applicable
- [ ] OpenAPI/generated types are updated
- [ ] Migration, backup, privacy, and rollback impact was considered
- [ ] Documentation is updated where behavior or operation changed
- [ ] No real portfolio data, credentials, logs, screenshots, or generated
      artifacts are included

## Compatibility

Describe any API, database, configuration, deployment, or user-data impact.
