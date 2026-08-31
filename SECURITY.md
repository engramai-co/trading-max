# Security Policy

Trading Max is a single-user, local-first portfolio application. It is not an
internet-facing service and does not implement multi-user authentication.

## Supported versions

The latest minor v1 release receives security fixes. Older versions may be
asked to upgrade before a report is investigated.

## Supported deployment boundary

- Local Workstation: API and web are loopback-only and the operating-system
  account is the access boundary.
- Personal Tailnet: the web process may be published through Tailscale Serve;
  the API remains loopback-only and is called by the server-side proxy.

Do not bind the API or web process to `0.0.0.0`, expose the internal API token
to browser code, or put Trading 212/LLM keys in Git, `.env.example`, logs,
URLs, browser storage, or screenshots.

## Reporting

Do not open a normal issue. Use GitHub private vulnerability reporting in the
canonical organization repository or email `contact@ingramai.co`.

Include reproduction steps, affected version/tag, impact, and whether real
credentials or portfolio data were involved. Never include the secret itself.
We aim to acknowledge reports within two business days and coordinate
disclosure after a fixed release is available.

Rotate any credential that may have been exposed before investigating logs or
history.
