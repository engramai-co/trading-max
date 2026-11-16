"""Deterministic assistant evals over current-turn tool calls and rendered text."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.usage import RunUsage
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from services.api.trading_max_api.agent.runtime import USAGE_LIMITS
from tools.assistant_eval_cases import Scenario, Tool

EVIDENCE_ID = re.compile(r"ev_[a-f0-9]{16}\Z")
MENTION = re.compile(r"ev_[a-zA-Z0-9_]+")
CITATION = re.compile(r"\[(ev_[a-f0-9]{16})\]")
STATUSES = frozenset({"ok", "partial", "unavailable", "not_applicable"})
CURRENCIES = {
    "£": "GBP",
    "GBP": "GBP",
    "POUND": "GBP",
    "POUNDS": "GBP",
    "英镑": "GBP",
    "英鎊": "GBP",
    "$": "USD",
    "US$": "USD",
    "USD": "USD",
    "美元": "USD",
    "€": "EUR",
    "EUR": "EUR",
    "欧元": "EUR",
    "歐元": "EUR",
    "CNY": "CNY",
    "RMB": "CNY",
    "人民币": "CNY",
    "人民幣": "CNY",
    "JPY": "JPY",
    "日元": "JPY",
    "日圓": "JPY",
    "HKD": "HKD",
    "HK$": "HKD",
    "港元": "HKD",
}
_CURRENCY = "|".join(map(re.escape, sorted(CURRENCIES, key=len, reverse=True)))
_NUMBER = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
_SCALE = {
    "K": 1000,
    "M": 1_000_000,
    "B": 1_000_000_000,
    "千": 1000,
    "万": 10_000,
    "萬": 10_000,
    "亿": 100_000_000,
    "億": 100_000_000,
    "THOUSAND": 1000,
    "MILLION": 1_000_000,
    "BILLION": 1_000_000_000,
}
_SCALE_PATTERN = r"thousand|million|billion|[kmb千万萬亿億]"
_FIGURE = re.compile(
    rf"""
    (?<![0-9.])
    (?P<sign>[+\-−])?\s*
    (?:
        (?<![a-z])(?P<prefix>{_CURRENCY})\s*(?P<inner>[+\-−])?\s*
        (?P<money>{_NUMBER})(?:\s*(?P<prefix_scale>{_SCALE_PATTERN})(?![a-z]))?
        |
        (?P<value>{_NUMBER})(?:\s*(?P<suffix_scale>{_SCALE_PATTERN})(?![a-z]))?\s*
        (?P<unit>%|percent\b|per\s+cent\b|个百分点|個百分點|percentage\s+points?\b|
            basis\s+points?\b|bps?\b|基点|基點|{_CURRENCY})(?![a-z])
        |
        百分之\s*(?P<zh_value>{_NUMBER})
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)
_TABLE_UNIT = re.compile(rf"(?<![a-z])({_CURRENCY}|%|percent\b)(?![a-z])", re.I)
_TABLE_SEPARATOR = re.compile(r":?-{3,}:?\Z")
_TABLE_AMOUNT = re.compile(rf"\s*([+\-−]?{_NUMBER})\s*\Z")
_LOSS = re.compile(
    r"(?:drawdown|loss|decline|fell|down|亏损|虧損|回撤|下跌)"
    r"(?:\s+(?:was|of|by))?\s*[:：]?\s*$",
    re.IGNORECASE,
)
_NUMERIC = re.compile(r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?\Z", re.I)
_MONEY_FIELDS = {
    "currentprice",
    "price",
    "regularmarketprice",
    "targetmedianprice",
    "spot",
    "grossresult",
    "fxfee",
    "resultafterfxfee",
    "amount",
}
_SCOPE_COMPONENTS = {
    "invest": {"invest"},
    "isa": {"isa"},
    "broker_total": {"invest", "isa"},
    "household": {"invest", "isa", "cfd"},
    "cfd": {"cfd"},
}
_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_LATIN = re.compile(r"[a-zA-Z]")
_ADVICE = re.compile(
    r"\b(?:you (?:should|must|ought to|need to|could|may want to)|"
    r"(?:i|we) (?:recommend|suggest|would)|(?:i|we)['’]d|my (?:advice|recommendation) is|"
    r"(?:the best move|your best option) is to)\s+"
    r"(?:\w+\s+){0,3}(?:buy(?:ing)?|sell(?:ing)?|short(?:ing)?|trim(?:ming)?|dump(?:ing)?|"
    r"exit(?:ing)?|allocat(?:e|ing)|increas(?:e|ing)|reduc(?:e|ing)|siz(?:e|ing)|"
    r"put(?:ting)?|invest(?:ing)?|hold(?:ing)?|tak(?:e|ing))\b"
    r"|(?:^|[.!?;\n]\s*)\s*(?:[-*]\s+)?(?:please\s+)?"
    r"(?:buy|sell|short|trim|dump|exit|allocate|put|invest|hold)\b\s+"
    r"(?:(?:all|some|half|in)\s+)?"
    r"(?:(?-i:[A-Z][A-Z0-9.:/-]+)|your\b|\d|[$£€])"
    r"|\b(?:i|we) (?:recommend|suggest)\s+(?:a\s+)?\d+(?:\.\d+)?%\s+"
    r"(?:position|weight|allocation)\b"
    r"|\b(?:target|recommended|optimal|ideal)\s+(?:position size|weight|allocation)\b"
    r"\s*(?:is|of|:|=)?\s*\d"
    r"|(?:建议你|建議你|你应该|你應該|你应当|你應當|你需要|你可以考虑|你可以考慮|"
    r"建议(?:直接|现在|現在)?|建議(?:直接|现在|現在)?|务必|務必)"
    r"\s*(?:买|買|卖|賣|减仓|減倉|加仓|加倉|清仓|清倉|做空|配置|投入|持有)"
    r"|(?:^|[。！？；\n])\s*(?:请|請)?(?:买入|買入|卖出|賣出|配置|减仓|減倉|清仓|清倉)"
    r"\s*(?:[A-Z]{2,}|\d)"
    r"|(?:目标|目標|最佳|合适|合適)(?:仓位|倉位)\s*(?:是|为|為|[:：])?\s*\d",
    re.I,
)
_NEGATED_CHINESE = re.compile(r"(?:不能|无法|無法|不会|不會|不应|不應|不)\s*(?:直接|贸然|貿然)?$")


@dataclass(frozen=True)
class Receipt:
    tool: str
    envelope: dict[str, Any]


@dataclass
class Turn:
    answer: str = ""
    calls: list[Tool] = field(default_factory=list)
    receipts: list[Receipt] = field(default_factory=list)
    tool_errors: int = 0
    error: str | None = None
    usage: RunUsage = field(default_factory=RunUsage)
    first_text_ms: float | None = None
    total_ms: float = 0.0


@dataclass(frozen=True)
class Figure:
    unit: str
    value: Decimal
    half_step: Decimal

    def matches(self, source: tuple[str, Decimal]) -> bool:
        unit, value = source
        return self.unit == unit and abs(self.value - value) <= self.half_step + Decimal("1e-10")


def _plain(text: str) -> str:
    return unicodedata.normalize("NFKC", text).replace("**", "").replace("__", "").replace("~", "")


def _with_table_units(text: str) -> str:
    """Make units inherited from a Markdown table header explicit on each row."""
    lines = text.splitlines()
    units: list[str | None] = []
    for index, line in enumerate(lines):
        if "|" not in line:
            units = []
            continue
        cells = line.strip().strip("|").split("|")
        if all(_TABLE_SEPARATOR.fullmatch(cell.strip()) for cell in cells) and index:
            headers = lines[index - 1].strip().strip("|").split("|")
            units = [
                match[1].upper() if (match := _TABLE_UNIT.search(header)) else None
                for header in headers
            ]
        elif len(cells) == len(units):
            for column, (cell, unit) in enumerate(zip(cells, units, strict=True)):
                if unit and (match := _TABLE_AMOUNT.fullmatch(cell)):
                    cells[column] = f" {match[1]} {unit} "
            lines[index] = "|" + "|".join(cells) + "|"
    return "\n".join(lines)


def figures(text: str) -> list[Figure]:
    text = _with_table_units(_plain(text))
    found = []
    for match in _FIGURE.finditer(text):
        numeric = (match["money"] or match["value"] or match["zh_value"]).replace(",", "")
        scale = Decimal(
            _SCALE.get((match["prefix_scale"] or match["suffix_scale"] or "").upper(), 1)
        )
        notation = (match["prefix"] or match["unit"] or "%").upper()
        unit = CURRENCIES.get(notation, "%")
        if notation.startswith("BASIS") or notation in {"BP", "BPS", "基点", "基點"}:
            scale /= 100
        sign = match["inner"] or match["sign"]
        if sign in {"-", "−"} or (not sign and _LOSS.search(text[: match.start()])):
            numeric = "-" + numeric
        value = Decimal(numeric)
        found.append(Figure(unit, value * scale, scale.scaleb(value.as_tuple().exponent) / 2))
    return found


def _decimal(raw: Any) -> Decimal | None:
    if type(raw) not in {str, int, float, Decimal} or not _NUMERIC.fullmatch(str(raw)):
        return None
    try:
        value = Decimal(str(raw))
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def _source_figures(data: Any, currency: str | None = None) -> set[tuple[str, Decimal]]:
    if isinstance(data, list):
        # Technical research lens projects the price and its currency as
        # separate JSON pointer rows within the same dataset.
        currencies = {
            row.get("dataset"): row["value"]
            for row in data
            if isinstance(row, dict)
            and row.get("path") == "/currency"
            and isinstance(row.get("value"), str)
        }
        return {
            figure
            for row in data
            for figure in _source_figures(
                row,
                currencies.get(row.get("dataset"), currency) if isinstance(row, dict) else currency,
            )
        }
    if not isinstance(data, dict):
        return set()
    currency = data.get("currency") or data.get("value_currency") or currency
    result: set[tuple[str, Decimal]] = set()
    for name, item in data.items():
        if isinstance(item, dict | list):
            result.update(_source_figures(item, currency))
            continue
        value = _decimal(item)
        if value is None:
            continue
        key = name.replace("_", "").lower()
        if key == "value" and isinstance(data.get("path"), str):
            key = data["path"].rsplit("/", 1)[-1].lower()
        if key.endswith("gbp"):
            result.add(("GBP", value))
        elif key.endswith(("fraction", "pct")) or (
            key == "value" and data.get("unit") in {"ratio", "fraction"}
        ):
            result.add(("%", value * 100))
        elif key == "currentprice" and data.get("price_currency"):
            result.add((data["price_currency"], value))
        elif currency and (
            key in _MONEY_FIELDS or (key == "value" and data.get("unit") in {"money", "perShare"})
        ):
            result.add((currency, value))
    return result


def _evidence(turn: Turn) -> dict[str, set[tuple[str, Decimal]]]:
    return {
        evidence_id: _source_figures(receipt.envelope.get("data"))
        for receipt in turn.receipts
        if isinstance(evidence_id := receipt.envelope.get("evidence_id"), str)
        and EVIDENCE_ID.fullmatch(evidence_id)
    }


type Context = EvaluatorContext[Scenario, Turn, None]


@dataclass
class ExpectedTools(Evaluator[Scenario, Turn, None]):
    def evaluate(self, ctx: Context) -> bool:
        return all(
            any(
                seen.name == expected.name
                and all(seen.args.get(key) == value for key, value in expected.args.items())
                for seen in ctx.output.calls
            )
            for expected in ctx.inputs.tools
        )


@dataclass
class GroundedFigures(Evaluator[Scenario, Turn, None]):
    def evaluate(self, ctx: Context) -> bool:
        evidence = {figure for values in _evidence(ctx.output).values() for figure in values}
        return all(
            any(figure.matches(source) for source in evidence)
            for figure in figures(ctx.output.answer)
        )


@dataclass
class EvidenceCitations(Evaluator[Scenario, Turn, None]):
    def evaluate(self, ctx: Context) -> bool:
        answer = _with_table_units(_plain(ctx.output.answer))
        evidence = _evidence(ctx.output)
        if set(MENTION.findall(answer)) - evidence.keys():
            return False
        # Treat each paragraph sentence or Markdown row as a separate claim.
        # Attach citations immediately after punctuation to the prior sentence.
        for line in re.split(r"\n|(?<=[.!?])\s+(?!\s*\[ev_)|(?<=[。！？])(?!\s*\[ev_)", answer):
            candidates = {value for key in CITATION.findall(line) for value in evidence[key]}
            if not all(
                any(figure.matches(source) for source in candidates) for figure in figures(line)
            ):
                return False
        return True


@dataclass
class NoPersonalAdvice(Evaluator[Scenario, Turn, None]):
    def evaluate(self, ctx: Context) -> bool:
        answer = _plain(ctx.output.answer)
        return all(
            _NEGATED_CHINESE.search(answer[: match.start()]) for match in _ADVICE.finditer(answer)
        )


@dataclass
class ReplyLanguage(Evaluator[Scenario, Turn, None]):
    def evaluate(self, ctx: Context) -> bool:
        clean = MENTION.sub("", ctx.output.answer)
        han, latin = len(_HAN.findall(clean)), len(_LATIN.findall(clean))
        if ctx.inputs.language == "zh":
            return han >= 3 and han * 2 >= latin
        return latin >= 10 and latin >= han * 3


@dataclass
class HealthyRun(Evaluator[Scenario, Turn, None]):
    def evaluate(self, ctx: Context) -> bool:
        turn = ctx.output
        limit = USAGE_LIMITS.request_limit
        if (
            turn.error
            or turn.tool_errors
            or not turn.answer.strip()
            or turn.usage.unmeasured_requests
            or (limit is not None and turn.usage.requests > limit)
        ):
            return False
        try:
            USAGE_LIMITS.check_tokens(turn.usage)
            USAGE_LIMITS.check_before_tool_call(turn.usage)
        except UsageLimitExceeded:
            return False
        return True


@dataclass
class CaseExpectations(Evaluator[Scenario, Turn, None]):
    def evaluate(self, ctx: Context) -> bool:
        scenario, turn = ctx.inputs, ctx.output
        answer = _plain(turn.answer)
        reported = figures(answer)
        scopes = [call.args.get("scope") for call in turn.calls if "scope" in call.args]
        scopes += [
            receipt.envelope.get("scope")
            for receipt in turn.receipts
            if receipt.envelope.get("scope") != "public_research"
        ]
        return (
            all(
                isinstance(scope, str)
                and scope in scenario.scopes
                and _SCOPE_COMPONENTS[scope] <= scenario.scopes
                for scope in scopes
            )
            and all(re.search(pattern, answer, re.I) for pattern in scenario.concepts)
            and not any(re.search(pattern, answer, re.I) for pattern in scenario.forbidden)
            and all(
                any(output.matches((expected.unit, expected.value)) for output in reported)
                for display in scenario.figures
                for expected in figures(display)
            )
        )


DETERMINISTIC = (
    ExpectedTools(),
    GroundedFigures(),
    EvidenceCitations(),
    NoPersonalAdvice(),
    ReplyLanguage(),
    HealthyRun(),
    CaseExpectations(),
)
