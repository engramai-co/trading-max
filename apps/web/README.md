# Trading Max Portfolio Dashboard

Private, responsive Next.js UI for the Trading Max API.
The visual language follows Wealthfolio's quiet, high-density portfolio layout,
but no Wealthfolio backend code, branding, accounting engine, or asset is used
by the application.

## Data contract

Next.js has no direct persistence or broker access. With
`PORTFOLIO_BACKEND_URL` configured, server components and the backend proxy load
dashboard, research, refresh, settings, and analysis payloads from the versioned
FastAPI contract. There is no filesystem or legacy-artifact fallback.

The browser never receives Trading 212 credentials, the backend write token,
or filesystem paths. PDF and CFD surfaces are deliberately absent.

## Local development

```bash
npm install
PORTFOLIO_BACKEND_URL=http://127.0.0.1:8421 npm run dev
```

Open `http://127.0.0.1:3000`.

On-demand refreshes are submitted through `POST /api/backend/refresh`; refresh
state is polled through `GET /api/backend/refresh`. Both keep the backend token
server-side. The refresh control exposes the independent ten-minute intraday
anchor schedule and the four-times-daily full schedule. A successful intraday job
refreshes the visible dashboard without blocking navigation; its unverified
cash-flow status is surfaced by the 1D/1W value-change chart.
