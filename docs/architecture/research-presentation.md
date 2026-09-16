# Research navigation and chart responsibilities

The company header identifies the security with its name, ticker and cached logo.
Pinning belongs to the research-list heading; mobile uses a drawer.

Overview shows a fixed three-month closing-price line. Price & technicals has
three URL-addressable sections: chart, technical data, and seasonality.
The ordinary chart offers range, line/candles, volume and optional averages.
Full chart exposes interval, axis, benchmark, RSI, MACD, average periods and zoom.
Full-chart state survives closing without changing the ordinary chart's defaults.

Automatic intervals are 15 minutes for 1D/5D, daily for 1M–2Y/YTD and weekly for
all history. Interval choices reject unsupported ranges and actual coverage is
shown when the provider cannot supply a full range. Portfolio NAV sampling is
independent of these security-price intervals.

The private HTML tutorial is not part of the application or repository.
