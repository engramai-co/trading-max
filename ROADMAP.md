# Roadmap

## V1 foundation

- [x] production-grade local macOS runtime and agent onboarding;
- [x] protected organization repository with CI and security gates;
- [x] versioned release workflow, backups, restore, and rollback contracts;
- [x] complete read-only broker, analytics, research, and optional LLM surface.

## Next minor releases

- improve first-run onboarding and backup status in Health;
- package and test Linux desktop service management;
- add signed update metadata and release provenance;
- expand synthetic end-to-end and accessibility coverage.

## Explicit non-goals

- brokerage order placement or trading permissions;
- public-internet exposure without a separately designed authentication model;
- multi-user tenancy;
- promising support for providers whose terms do not permit the required use;
- silently substituting estimated values for missing broker or market data.

Feature proposals should open an issue and explain user value, data source,
privacy impact, failure behaviour, and maintenance cost.
