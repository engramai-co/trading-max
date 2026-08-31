# Governance

Trading Max is an Engram-led open-source project. The project lead is the final
product and release decision maker while the maintainer team is small.

## Decision process

- Documentation, tests, and backwards-compatible bug fixes may be approved by
  one maintainer.
- User-facing features and material data-model changes require an issue or RFC
  that records motivation, alternatives, migration, privacy, and test impact.
- Breaking API, configuration, database, or deployment changes require an RFC
  and a major-version decision.
- Security fixes may be developed privately and disclosed after a patched
  release is available.
- Governance and licensing changes require a public proposal and approval from
  the project lead.

Maintainers prefer durable reasoning in repository issues and pull requests
over ephemeral chat. Financial correctness, privacy, recoverability, and a small
supported deployment surface take priority over feature count.

## Merge policy

Changes merge through reviewed pull requests after required CI, Security, and
Release contract checks pass. Every merged pull request advances SemVer and is
published by the automated release workflow. Direct pushes are reserved for
repository recovery and security incidents and must be documented afterward.

## Maintainers

Current roles and the path to maintainership are documented in
[MAINTAINERS.md](MAINTAINERS.md).
