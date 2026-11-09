"""Pure sector-board arithmetic for one market session.

Every change is a fraction of a member's previous close. A group's change is
the weight-averaged change of its priced members; its intraday path applies the
same average at every five-minute bucket, carrying each member's latest price
forward (a member that has not traded yet counts as unchanged). Ranks order a
grouping's groups by weighted session return, best first, and a streak counts
the latest consecutive sessions ranked in the top three. A group is ranked in a
session only when prices cover at least half of its weight, so a few priced
names never stand in for a thinly priced group. Once the session has closed,
only prices that reach the close rank a group in that session: they must cover
it, and their return alone is ranked, so a move frozen earlier in the day never
ranks among settled ones. The change shown still averages every priced member.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from itertools import pairwise

FLAT_BAND = 0.0005
# Float error must not turn a move of exactly the band into a rise or a fall.
FLAT_TOLERANCE = 1e-9
MIN_RANK_COVERAGE = 0.5
TOP_RANK = 3
BUCKET = timedelta(minutes=5)
# Closing auctions print after the scheduled close; Hong Kong's runs ten minutes.
LATE_PRINTS = timedelta(minutes=15)


@dataclass(frozen=True, slots=True)
class MemberSession:
    """A member's prices in one session: five-minute buckets and their latest price."""

    previous_close: float
    times: tuple[datetime, ...]
    closes: tuple[float, ...]
    observed_at: datetime

    @property
    def change(self) -> float:
        return self.closes[-1] / self.previous_close - 1


@dataclass(frozen=True, slots=True)
class BoardMember:
    """One constituent of a grouping; weights need not sum to one."""

    symbol: str
    name: str
    group: str
    weight: float
    subgroup: str = ""
    exposure_gbp: float = 0.0
    research_ticker: str | None = None


@dataclass(frozen=True, slots=True)
class GroupLabel:
    key: str
    name: str
    name_zh: str | None = None


@dataclass(frozen=True, slots=True)
class Breadth:
    up: int = 0
    flat: int = 0
    down: int = 0


@dataclass(frozen=True, slots=True)
class Leader:
    symbol: str
    name: str
    change: float


@dataclass(frozen=True, slots=True)
class MemberResult:
    symbol: str
    name: str
    subgroup: str
    change: float | None
    weight: float
    exposure_gbp: float
    research_ticker: str | None


@dataclass(frozen=True, slots=True)
class SubgroupResult:
    key: str
    name: str
    change: float | None
    weight: float
    breadth: Breadth
    member_count: int
    exposure_gbp: float


@dataclass(frozen=True, slots=True)
class GroupResult:
    key: str
    name: str
    name_zh: str | None
    change: float | None
    weight: float
    breadth: Breadth
    member_count: int
    leader: Leader | None
    path: list[float | None]
    ranks: list[int | None]
    streak: int
    exposure_gbp: float
    subgroups: list[SubgroupResult]
    members: list[MemberResult]


@dataclass(frozen=True, slots=True)
class GroupingResult:
    kind: str
    groups: list[GroupResult]


def _positive(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) and number > 0 else None


def _bucket(at: datetime) -> datetime:
    seconds = int(at.timestamp())
    return datetime.fromtimestamp(seconds - seconds % int(BUCKET.total_seconds()), UTC)


def _round(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(value, digits)


def member_session(
    timestamps: Sequence[float],
    closes: Sequence[object],
    previous_close: object,
    *,
    session_open: datetime,
    session_close: datetime,
) -> MemberSession | None:
    """Bucket a member's provider prices that belong to one session.

    Prices before the open or after the closing auction (another day's bars)
    are ignored, and the latest price in a bucket wins. Closing-auction prints
    after the bell fold into the bucket at the close. Returns None when the
    session has no usable price or the previous close is unknown.
    """

    base = _positive(previous_close)
    if base is None:
        return None
    close_bucket = _bucket(session_close)
    buckets: dict[datetime, float] = {}
    latest: datetime | None = None
    points = sorted(zip(timestamps, closes, strict=False), key=lambda point: point[0])
    for stamp, value in points:
        price = _positive(value)
        if price is None:
            continue
        at = datetime.fromtimestamp(float(stamp), UTC)
        if at < session_open or at > session_close + LATE_PRINTS:
            continue
        buckets[min(_bucket(at), close_bucket)] = price
        latest = at
    if latest is None:
        return None
    times = tuple(sorted(buckets))
    # A bucket start before the close carries that bucket's closing price; a
    # live or closing print carries its own time.
    observed = latest + BUCKET if latest == _bucket(latest) and latest < session_close else latest
    return MemberSession(base, times, tuple(buckets[time] for time in times), observed)


def settle(
    session: MemberSession | None,
    official_close: object,
    previous_close: object,
    *,
    session_close: datetime,
) -> MemberSession | None:
    """End a member's session on its official closing price.

    Intraday bars can stop before the closing auction, so the official close
    takes the bucket at the close. A member without intraday prices gets a
    session of the close alone, anchored on the previous official close.
    Without an official close the session is returned unchanged.
    """

    close = _positive(official_close)
    if close is None:
        return session
    bucket = _bucket(session_close)
    if session is None:
        base = _positive(previous_close)
        if base is None:
            return None
        return MemberSession(base, (bucket,), (close,), session_close)
    kept = [index for index, time in enumerate(session.times) if time < bucket]
    return MemberSession(
        session.previous_close,
        (*(session.times[index] for index in kept), bucket),
        (*(session.closes[index] for index in kept), close),
        session_close,
    )


def closes_at_close(session: MemberSession, session_close: datetime) -> bool:
    """Whether a member's prices reach the close (its last bucket or the one before)."""

    return session.times[-1] >= _bucket(session_close) - BUCKET


def board_times(sessions: Iterable[MemberSession]) -> list[datetime]:
    """Every bucket any member traded in, ascending."""

    return sorted({time for session in sessions for time in session.times})


def board_as_of(
    sessions: Iterable[MemberSession],
    fetched_at: datetime,
    session_close: datetime | None = None,
) -> datetime | None:
    """When the latest included price was observed.

    Never later than the fetch, and closing-auction prints after the bell
    count as the close.
    """

    latest = max((session.observed_at for session in sessions), default=None)
    if latest is None:
        return None
    return min(latest, fetched_at, session_close or latest)


def weighted_mean(pairs: Iterable[tuple[float, float]]) -> float | None:
    """Weight-averaged value; equal weights when every weight is zero."""

    items = list(pairs)
    if not items:
        return None
    total = sum(weight for _, weight in items)
    if total > 0:
        return sum(value * weight for value, weight in items) / total
    return sum(value for value, _ in items) / len(items)


def breadth(changes: Iterable[float]) -> Breadth:
    """Members up, unchanged within the flat band (inclusive), and down."""

    band = FLAT_BAND + FLAT_TOLERANCE
    up = flat = down = 0
    for change in changes:
        if change > band:
            up += 1
        elif change < -band:
            down += 1
        else:
            flat += 1
    return Breadth(up=up, flat=flat, down=down)


def competition_ranks(values: Mapping[str, float | None]) -> dict[str, int | None]:
    """Rank 1 is the highest value; equal values share a rank; missing values have none."""

    present = [value for value in values.values() if value is not None]
    return {
        key: None if value is None else 1 + sum(other > value for other in present)
        for key, value in values.items()
    }


def top_streak(ranks: Sequence[int | None], top: int = TOP_RANK) -> int:
    """Consecutive latest ranks within the top ones."""

    streak = 0
    for rank in reversed(ranks):
        if rank is None or rank > top:
            break
        streak += 1
    return streak


def rankable(
    members: Sequence[BoardMember], priced: Iterable[BoardMember], min_members: int = 1
) -> bool:
    """Whether priced members cover enough of a group to rank it.

    Coverage is by weight, or by count when no member has weight.
    """

    counted = list(priced)
    if len(counted) < max(min_members, 1):
        return False
    total = sum(max(member.weight, 0.0) for member in members)
    if total > 0:
        share = sum(max(member.weight, 0.0) for member in counted) / total
    else:
        share = len(counted) / len(members)
    return share >= MIN_RANK_COVERAGE


def _path(
    priced: Sequence[tuple[float, MemberSession]],
    times: Sequence[datetime],
) -> list[float | None]:
    if not priced:
        return [None] * len(times)
    total_weight = sum(weight for weight, _ in priced)
    equal = total_weight <= 0
    totals = [0.0] * len(times)
    for weight, session in priced:
        index = 0
        change = 0.0
        for position, time in enumerate(times):
            while index < len(session.times) and session.times[index] <= time:
                change = session.closes[index] / session.previous_close - 1
                index += 1
            totals[position] += (1.0 if equal else weight) * change
    denominator = len(priced) if equal else total_weight
    return [_round(total / denominator) for total in totals]


def _session_returns(
    members: Sequence[BoardMember],
    daily: Mapping[str, Mapping[str, float]],
    sessions: Sequence[str],
    min_members: int = 1,
) -> list[float | None]:
    """A group's weighted return on each session after the first.

    A session without closes for enough of the group has no return.
    """

    returns: list[float | None] = []
    for previous, current in pairwise(sessions):
        priced: list[tuple[BoardMember, float]] = []
        for member in members:
            closes = daily.get(member.symbol) or {}
            before = _positive(closes.get(previous))
            after = _positive(closes.get(current))
            if before is not None and after is not None:
                priced.append((member, after / before - 1))
        if not rankable(members, (member for member, _ in priced), min_members):
            returns.append(None)
            continue
        returns.append(
            weighted_mean((change, max(member.weight, 0.0)) for member, change in priced)
        )
    return returns


def build_grouping(
    kind: str,
    labels: Sequence[GroupLabel],
    members: Sequence[BoardMember],
    sessions: Mapping[str, MemberSession],
    *,
    times: Sequence[datetime],
    daily: Mapping[str, Mapping[str, float]] | None = None,
    daily_sessions: Sequence[str] = (),
    subgroup_names: Mapping[str, str] | None = None,
    min_priced: int = 0,
    final_close: datetime | None = None,
) -> GroupingResult:
    """Summarise each labelled group of one grouping for a session.

    ``daily_sessions`` lists completed sessions before the board's, oldest
    first. The first only anchors the second's return, so ranks cover the
    later ones and then the board's own session. Groups with fewer than
    ``min_priced`` priced members are left out; weights are fractions of the
    members of the groups kept. Ranking also needs ``min_priced`` members
    with prices in that session, covering at least half of the group's weight.
    ``final_close`` is the board's session close once that session has
    ended: then only members whose prices reach the close count toward the
    group's rank in it, both to cover the group and as the weighted return
    ranked. The change shown still averages every priced member; a group the
    closing members do not cover keeps it, unranked.
    """

    by_group: dict[str, list[BoardMember]] = defaultdict(list)
    for member in members:
        by_group[member.group].append(member)
    kept = [
        label
        for label in labels
        if sum(member.symbol in sessions for member in by_group.get(label.key, ())) >= min_priced
    ]
    universe = sum(
        max(member.weight, 0.0) for label in kept for member in by_group.get(label.key, ())
    )
    names = subgroup_names or {}
    history_source = daily or {}

    def share(weight: float) -> float:
        return round(weight / universe, 8) if universe > 0 else 0.0

    def money(values: Iterable[float]) -> float:
        return round(sum(values), 2)

    groups: list[GroupResult] = []
    ranked_changes: list[float | None] = []
    histories: list[list[float | None]] = []
    for label in kept:
        group_members = by_group.get(label.key, [])
        priced = [
            (member, sessions[member.symbol])
            for member in group_members
            if member.symbol in sessions
        ]
        change = weighted_mean(
            (session.change, max(member.weight, 0.0)) for member, session in priced
        )
        leader = None
        if priced:
            top_member, top_session = max(priced, key=lambda item: (item[1].change, item[0].weight))
            leader = Leader(
                symbol=top_member.symbol,
                name=top_member.name,
                change=round(top_session.change, 6),
            )
        subgroups = [
            SubgroupResult(
                key=code,
                name=names.get(code, code) if code else "",
                change=_round(
                    weighted_mean(
                        (sessions[member.symbol].change, max(member.weight, 0.0))
                        for member in inside
                        if member.symbol in sessions
                    )
                ),
                weight=share(sum(max(member.weight, 0.0) for member in inside)),
                breadth=breadth(
                    sessions[member.symbol].change for member in inside if member.symbol in sessions
                ),
                member_count=len(inside),
                exposure_gbp=money(member.exposure_gbp for member in inside),
            )
            for code, inside in _by_subgroup(group_members)
        ]
        results = sorted(
            (
                MemberResult(
                    symbol=member.symbol,
                    name=member.name,
                    subgroup=member.subgroup,
                    change=_round(sessions[member.symbol].change)
                    if member.symbol in sessions
                    else None,
                    weight=share(max(member.weight, 0.0)),
                    exposure_gbp=round(member.exposure_gbp, 2),
                    research_ticker=member.research_ticker,
                )
                for member in group_members
            ),
            key=lambda result: (-result.weight, result.symbol),
        )
        groups.append(
            GroupResult(
                key=label.key,
                name=label.name,
                name_zh=label.name_zh,
                change=_round(change),
                weight=share(sum(max(member.weight, 0.0) for member in group_members)),
                breadth=breadth(session.change for _, session in priced),
                member_count=len(group_members),
                leader=leader,
                path=_path(
                    [(max(member.weight, 0.0), session) for member, session in priced], times
                ),
                ranks=[],
                streak=0,
                exposure_gbp=money(member.exposure_gbp for member in group_members),
                subgroups=subgroups,
                members=results,
            )
        )
        # Before the close this is every priced member, and the rank follows the change.
        settled = [
            (member, session)
            for member, session in priced
            if final_close is None or closes_at_close(session, final_close)
        ]
        covered = rankable(group_members, (member for member, _ in settled), min_priced)
        ranked_changes.append(
            weighted_mean((session.change, max(member.weight, 0.0)) for member, session in settled)
            if covered
            else None
        )
        histories.append(
            _session_returns(group_members, history_source, daily_sessions, min_priced)
        )

    # Rank every session at once: earlier sessions from daily closes, the
    # board's own session from its latest (after the close, closing) prices.
    columns: list[dict[str, float | None]] = [
        {group.key: history[index] for group, history in zip(groups, histories, strict=True)}
        for index in range(max(len(daily_sessions) - 1, 0))
    ]
    columns.append(
        {group.key: change for group, change in zip(groups, ranked_changes, strict=True)}
    )
    ranked = [competition_ranks(column) for column in columns]
    final = []
    for group in groups:
        ranks = [column[group.key] for column in ranked]
        final.append(replace(group, ranks=ranks, streak=top_streak(ranks)))
    return GroupingResult(kind=kind, groups=final)


def _by_subgroup(members: Sequence[BoardMember]) -> list[tuple[str, list[BoardMember]]]:
    """Industry groups in code order, then the unclassified rest as key "".

    The rest is listed only beside classified groups, so a partly classified
    sector still reaches all of its members.
    """

    grouped: dict[str, list[BoardMember]] = defaultdict(list)
    rest: list[BoardMember] = []
    for member in members:
        if member.subgroup:
            grouped[member.subgroup].append(member)
        else:
            rest.append(member)
    ordered = sorted(grouped.items())
    return [*ordered, ("", rest)] if ordered and rest else ordered


__all__ = [
    "BUCKET",
    "FLAT_BAND",
    "FLAT_TOLERANCE",
    "LATE_PRINTS",
    "MIN_RANK_COVERAGE",
    "TOP_RANK",
    "BoardMember",
    "Breadth",
    "GroupLabel",
    "GroupResult",
    "GroupingResult",
    "Leader",
    "MemberResult",
    "MemberSession",
    "SubgroupResult",
    "board_as_of",
    "board_times",
    "breadth",
    "build_grouping",
    "closes_at_close",
    "competition_ranks",
    "member_session",
    "rankable",
    "settle",
    "top_streak",
    "weighted_mean",
]
