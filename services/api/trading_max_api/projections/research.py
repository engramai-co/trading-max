"""Pure research artifact projections shared by dashboard and ticker lenses."""

from __future__ import annotations

from .values import JsonObject, nullable_number, number_value


def technical_rows(raw: JsonObject) -> list[JsonObject]:
    result: list[JsonObject] = []
    for row in raw.get("rows", []):
        momentum = row.get("momentum") or {}
        macd = momentum.get("macd") or {}
        moving = row.get("moving_averages") or {}
        structure = row.get("structure") or {}
        returns = row.get("returns") or {}
        strength = row.get("trend_strength") or {}
        coverage = row.get("history_coverage") or {}
        adr = row.get("adr_research")
        result.append(
            {
                "ticker": str(row.get("ticker")),
                "asOf": str(row.get("as_of") or raw.get("as_of") or ""),
                "currency": str(row.get("currency") or ""),
                "historyCoverage": {
                    "requestedPeriod": str(coverage.get("requested_period") or ""),
                    "availableSessions": number_value(coverage.get("available_sessions")),
                    "firstSession": str(coverage.get("first_session") or ""),
                    "lastSession": str(coverage.get("last_session") or ""),
                    "complete": bool(coverage.get("complete", True)),
                    "warning": coverage.get("warning"),
                },
                "adrResearch": (
                    {
                        "securityType": str(adr.get("security_type") or "ADR"),
                        "adrTicker": str(adr.get("adr_ticker") or ""),
                        "primaryTicker": str(adr.get("primary_ticker") or ""),
                        "depositary": str(adr.get("depositary") or ""),
                        "ordinarySharesPerAdr": number_value(adr.get("ordinary_shares_per_adr")),
                        "adrPerOrdinaryShare": number_value(adr.get("adr_per_ordinary_share")),
                        "adrSpotUsd": number_value(adr.get("adr_spot_usd")),
                        "primarySpot": number_value(adr.get("primary_spot")),
                        "primaryCurrency": str(adr.get("primary_currency") or ""),
                        "fxLocalPerUsd": number_value(adr.get("fx_local_per_usd")),
                        "parityUsd": number_value(adr.get("parity_usd")),
                        "premiumToParity": number_value(adr.get("premium_to_parity")),
                        "availableSessions": number_value(adr.get("available_sessions")),
                        "firstTradeSession": str(adr.get("first_trade_session") or ""),
                        "averageVolume20d": number_value(adr.get("average_volume_20d")),
                        "averageDollarVolume20d": number_value(
                            adr.get("average_dollar_volume_20d")
                        ),
                        "arbitrageAssumption": str(adr.get("arbitrage_assumption") or "none"),
                        "warning": str(adr.get("warning") or ""),
                        "ratioSource": str(adr.get("ratio_source") or ""),
                    }
                    if isinstance(adr, dict)
                    else None
                ),
                "price": number_value(row.get("price")),
                "score": number_value(row.get("technical_score")),
                "state": str(row.get("technical_state") or "—"),
                "rsi": nullable_number(momentum.get("rsi14")),
                "macd": nullable_number(macd.get("line")),
                "macdSignal": nullable_number(macd.get("signal")),
                "macdHistogram": nullable_number(macd.get("histogram")),
                "sma20": nullable_number(moving.get("sma20")),
                "sma50": nullable_number(moving.get("sma50")),
                "sma200": nullable_number(moving.get("sma200")),
                "support20": nullable_number(structure.get("support20")),
                "resistance20": nullable_number(structure.get("resistance20")),
                "drawdown52w": nullable_number(structure.get("drawdown_from_52w_high")),
                "return20d": nullable_number(returns.get("r_20d")),
                "return63d": nullable_number(returns.get("r_63d")),
                "atrPct": nullable_number(strength.get("atr14_pct")),
                "atr": nullable_number(strength.get("atr14")),
                "adx": nullable_number(strength.get("adx14")),
                "plusDi": nullable_number(strength.get("plus_di14")),
                "minusDi": nullable_number(strength.get("minus_di14")),
                "stochasticK": nullable_number(momentum.get("stochastic_k14")),
                "stochasticD": nullable_number(momentum.get("stochastic_d3")),
                "high52w": nullable_number(structure.get("high52")),
                "low52w": nullable_number(structure.get("low52")),
                "bollingerUpper": nullable_number((structure.get("bollinger") or {}).get("upper")),
                "bollingerLower": nullable_number((structure.get("bollinger") or {}).get("lower")),
                "bollingerPosition": nullable_number(
                    (structure.get("bollinger") or {}).get("pct_b")
                ),
                "bollingerWidth": nullable_number(
                    (structure.get("bollinger") or {}).get("bandwidth")
                ),
                "volume": nullable_number((row.get("volume") or {}).get("volume")),
                "averageVolume20d": nullable_number(
                    (row.get("volume") or {}).get("average_volume_20d")
                ),
                "relativeVolume20d": nullable_number(
                    (row.get("volume") or {}).get("volume_vs_20d")
                ),
                "seasonality": [
                    dict(item) for item in row.get("seasonality", []) if isinstance(item, dict)
                ],
                "seasonalityMatrix": list(row.get("seasonality_matrix") or []),
                "yearPaths": dict(row.get("year_paths") or {}),
                "relativeStrength": dict(row.get("relative_strength") or {}),
                "trendStrength": dict(row.get("trend_strength") or {}),
                "seasonalityCoverage": {
                    "basis": str((row.get("seasonality_coverage") or {}).get("basis") or ""),
                    "firstSession": str(
                        (row.get("seasonality_coverage") or {}).get("first_session") or ""
                    ),
                    "lastSession": str(
                        (row.get("seasonality_coverage") or {}).get("last_session") or ""
                    ),
                    "dailySessions": number_value(
                        (row.get("seasonality_coverage") or {}).get("daily_sessions")
                    ),
                    "monthlyObservations": number_value(
                        (row.get("seasonality_coverage") or {}).get("monthly_observations")
                    ),
                },
                "signals": [str(item) for item in row.get("signals", [])],
            }
        )
    return result


def option_rows(raw: JsonObject) -> list[JsonObject]:
    result: list[JsonObject] = []
    raw_entries = raw.get("rows")
    entries = (
        raw_entries if isinstance(raw_entries, list) else list((raw.get("options") or {}).values())
    )
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        aggregate = entry.get("aggregate") or {}
        gamma = entry.get("gamma_proxy") or {}
        expiry_rows = entry.get("expiries") or []
        contract_rows = entry.get("contracts") or []
        result.append(
            {
                "ticker": str(entry.get("ticker")),
                "currency": entry.get("currency"),
                "modelInputs": entry.get("model_inputs") or {},
                "availableExpiries": entry.get("available_expiries") or [],
                "spot": number_value(entry.get("spot")),
                "expiryCount": number_value(entry.get("expiry_count")),
                "capturedAt": str(entry.get("captured_at") or entry.get("captured_at_utc") or ""),
                "putCallOiRatio": nullable_number(aggregate.get("put_call_oi_ratio")),
                "callWall": nullable_number((aggregate.get("call_oi_wall") or {}).get("strike")),
                "putWall": nullable_number((aggregate.get("put_oi_wall") or {}).get("strike")),
                "maxPain": nullable_number(aggregate.get("max_pain_proxy")),
                "netGex": nullable_number(aggregate.get("net_gex_1pct_proxy")),
                "gammaRegime": (
                    str(gamma.get("gamma_regime")) if gamma.get("gamma_regime") else None
                ),
                "gammaFlip": nullable_number(gamma.get("gamma_flip_proxy")),
                "gammaProfile": [
                    {
                        "spot": number_value(point.get("spot")),
                        "netGex": number_value(point.get("net_gex_1pct")),
                    }
                    for point in gamma.get("profile", [])
                ],
                "expiries": [
                    {
                        "expiry": str(row.get("expiry") or ""),
                        "daysToExpiry": nullable_number(row.get("days_to_expiry")),
                        "expiryInstant": row.get("expiry_instant"),
                        "netGex": nullable_number(row.get("net_gex_1pct_proxy")),
                        "gammaCoverage": int(row.get("gamma_coverage") or 0),
                        "contractCount": int(row.get("contract_count") or 0),
                        "gammaFlip": nullable_number(row.get("gamma_flip")),
                        "gammaProfile": [
                            {"spot": point["spot"], "netGex": point["net_gex_1pct"]}
                            for point in row.get("gamma_profile", [])
                        ],
                        "callOpenInterest": nullable_number(row.get("call_open_interest")),
                        "putOpenInterest": nullable_number(row.get("put_open_interest")),
                        "putCallOiRatio": nullable_number(row.get("put_call_oi_ratio")),
                        "callVolume": nullable_number(row.get("call_volume")),
                        "putVolume": nullable_number(row.get("put_volume")),
                        "callIv": nullable_number(row.get("call_oi_weighted_iv")),
                        "putIv": nullable_number(row.get("put_oi_weighted_iv")),
                        "callWall": nullable_number((row.get("call_oi_wall") or {}).get("strike")),
                        "putWall": nullable_number((row.get("put_oi_wall") or {}).get("strike")),
                        "maxPain": nullable_number(row.get("max_pain_proxy")),
                    }
                    for row in expiry_rows
                    if isinstance(row, dict)
                ],
                "contracts": [
                    {
                        "expiry": str(row.get("expiry") or ""),
                        "side": str(row.get("side") or ""),
                        "contractSymbol": (
                            str(row.get("contract_symbol")) if row.get("contract_symbol") else None
                        ),
                        "strike": number_value(row.get("strike")),
                        "lastPrice": nullable_number(row.get("last_price")),
                        "bid": nullable_number(row.get("bid")),
                        "ask": nullable_number(row.get("ask")),
                        "openInterest": nullable_number(row.get("open_interest")),
                        "volume": nullable_number(row.get("volume")),
                        "impliedVolatility": nullable_number(row.get("iv")),
                        "inTheMoney": bool(row.get("in_the_money", False)),
                        "lastTradeAt": row.get("last_trade_at"),
                        "quoteAsOf": row.get("quote_as_of"),
                        "openInterestAsOf": row.get("open_interest_as_of"),
                        "multiplier": nullable_number(row.get("multiplier")),
                        "exerciseStyle": row.get("exercise_style"),
                        "settlement": row.get("settlement"),
                        "expiryInstant": row.get("expiry_instant"),
                        "termsState": row.get("terms_state") or "unsupported",
                        "currency": row.get("currency"),
                        "gamma": nullable_number(row.get("gamma")),
                        "delta": nullable_number(row.get("delta")),
                        "gex1pct": nullable_number(row.get("gex_1pct")),
                    }
                    for row in contract_rows
                    if isinstance(row, dict) and row.get("side") in {"call", "put"}
                ],
            }
        )
    return result


def valuation_rows(raw: JsonObject) -> list[JsonObject]:
    result: list[JsonObject] = []
    for row in raw.get("rows", []):
        if not isinstance(row, dict):
            continue
        lenses = row.get("lenses") or {}
        spot = number_value(row.get("price") if "price" in row else row.get("spot"))
        ev5 = nullable_number(row.get("ev5"))
        ev10 = nullable_number(row.get("ev10"))
        result.append(
            {
                "ticker": str(row.get("ticker") or row.get("t") or ""),
                "asOf": str(row.get("as_of") or raw.get("as_of") or ""),
                "currency": str(row.get("currency") or row.get("ccy") or ""),
                "spot": spot,
                "ev5": ev5,
                "ev10": ev10,
                "analystMedian": nullable_number(row.get("med")),
                "impliedGrowth": nullable_number(row.get("impl")),
                "baseGrowth": nullable_number(row.get("base_g")),
                "verdict": str(row.get("verdict") or "—"),
                "trailingPe": nullable_number(lenses.get("trailingPE")),
                "forwardPe": nullable_number(lenses.get("forwardPE")),
                "priceToSales": nullable_number(lenses.get("priceToSalesTrailing12Months")),
                "priceToBook": nullable_number(lenses.get("priceToBook")),
                "enterpriseToEbitda": nullable_number(lenses.get("enterpriseToEbitda")),
                "ev5Upside": ev5 / spot - 1.0 if ev5 is not None and spot else None,
                "ev10Upside": (ev10 / spot - 1.0 if ev10 is not None and spot else None),
                "modelStatus": str(row.get("model_status") or "—"),
                "modelWarnings": row.get("model_warnings") or [],
                "method": str(row.get("method") or ""),
                "reportedGrowth": nullable_number(row.get("reported_g")),
                "impliedGrowthBound": str(row.get("implBound") or "") or None,
                "valueRange": row.get("valueRange") or {},
                "valueRange10": row.get("valueRange10") or {},
                "scenarios": row.get("scenarios") or {},
                "assumptions": row.get("assumptions") or {},
                "terminalCheck": row.get("terminalCheck") or {},
                "sensitivity": row.get("sensitivity") or None,
            }
        )
    return result
