# Deployment profiles

Trading Max separates the guided local product from an advanced, unattended
macOS service profile.

| Directory | Audience | Network boundary | Supported entry point |
|---|---|---|---|
| `local/` | local users and coding agents | loopback only | `uv run --package trading-max-backend trading-max onboard` |
| `macos/` | advanced operators | loopback services; optional private reverse proxy | exact protected-main SHA |

The local onboarding command never invokes `deploy/macos` or opens a LAN or
public listener.
Conversely, the advanced profile assumes the host, native credential store,
LaunchAgents, backups, and external state root were provisioned deliberately;
it is not the recommended first installation path.

`deploy/macos/deploy.sh` is CI-provider neutral. It accepts only a full commit
SHA reachable from `origin/main`, rebuilds from locked dependencies, applies
database schema updates, performs health/readiness checks, and rolls back on
failure. It is an operator tool, not a generic local updater.
