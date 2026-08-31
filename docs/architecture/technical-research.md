# Technical, options, and ADR research boundary

The canonical implementation is
`backend/src/trading_max/research/technical.py`.

It returns immutable-looking Pydantic artifacts for:

- adjusted daily OHLCV history and explicit coverage warnings;
- SMA/EMA, MACD, RSI, stochastic, Bollinger, ATR, ADX/DMI, volume/OBV,
  support/resistance, relative return, beta, and correlation;
- technical state and transparent 0–100 state score (not a trade signal);
- option OI/volume walls, put/call ratios, OI-weighted IV skew, max-pain proxy,
  signed GEX proxy, gamma walls, and gamma-flip profile;
- ADR parity, premium, liquidity, depositary, ratio source, and the explicit
  no-arbitrage assumption.

The module never splices an ADR chart into its home-market series. It keeps
history coverage explicit and raises `MarketDataError` when the minimum
history or option chain cannot be obtained. The options GEX convention is
stored in the artifact because public OI does not disclose dealer inventory.

The old dated technical script remains a compatibility entry point until a
fixture-by-fixture comparison is complete; it must not gain new calculations.
