from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from trading_max.analytics.sector_board import (
    BoardMember,
    GroupLabel,
    MemberSession,
    board_as_of,
    board_times,
    breadth,
    build_grouping,
    closes_at_close,
    competition_ranks,
    member_session,
    rankable,
    settle,
    top_streak,
)

OPEN = datetime(2026, 11, 6, 14, 30, tzinfo=UTC)
CLOSE = datetime(2026, 11, 6, 21, 0, tzinfo=UTC)


def stamp(minutes: float) -> int:
    return int((OPEN + timedelta(minutes=minutes)).timestamp())


def at(minutes: float) -> datetime:
    return OPEN + timedelta(minutes=minutes)


def session(previous: float, *points: tuple[float, float]) -> MemberSession:
    priced = member_session(
        [stamp(minutes) for minutes, _ in points],
        [price for _, price in points],
        previous,
        session_open=OPEN,
        session_close=CLOSE,
    )
    assert priced is not None
    return priced


def test_member_session_buckets_prices_and_keeps_the_latest_print_in_a_bucket() -> None:
    priced = member_session(
        [stamp(-1440), stamp(0), stamp(5), stamp(7.5), stamp(6)],
        [99.0, 100.0, 101.0, 103.0, 102.0],
        100.0,
        session_open=OPEN,
        session_close=CLOSE,
    )

    assert priced is not None
    assert priced.times == (at(0), at(5))
    assert priced.closes == (100.0, 103.0)
    assert priced.change == pytest.approx(0.03)
    # A live print reports its own time.
    assert priced.observed_at == at(7.5)


def test_member_session_dates_a_completed_bucket_at_its_end_and_a_close_at_the_close() -> None:
    bucket = member_session(
        [stamp(0), stamp(5)], [10.0, 11.0], 10.0, session_open=OPEN, session_close=CLOSE
    )
    closing = member_session(
        [stamp(385), stamp(390)], [10.0, 12.0], 10.0, session_open=OPEN, session_close=CLOSE
    )
    late = member_session([stamp(390 + 20)], [12.0], 10.0, session_open=OPEN, session_close=CLOSE)

    assert bucket is not None and bucket.observed_at == at(10)
    assert closing is not None and closing.observed_at == CLOSE
    assert closing.times[-1] == CLOSE
    assert late is None


@pytest.mark.parametrize("previous", [None, 0, -1.0, float("nan"), "n/a"])
def test_member_session_needs_a_previous_close(previous: object) -> None:
    assert (
        member_session([stamp(0)], [10.0], previous, session_open=OPEN, session_close=CLOSE) is None
    )


def test_member_session_ignores_missing_and_invalid_prices() -> None:
    assert (
        member_session(
            [stamp(0), stamp(5)],
            [None, float("nan")],
            10.0,
            session_open=OPEN,
            session_close=CLOSE,
        )
        is None
    )


def test_breadth_counts_moves_beyond_the_flat_band() -> None:
    assert breadth([0.0006, 0.0004, -0.0004, -0.0006, 0.0, 0.02]) == breadth(
        [0.02, 0.0006, 0.0, 0.0004, -0.0004, -0.0006]
    )
    counted = breadth([0.0006, 0.0004, -0.0004, -0.0006, 0.0, 0.02])
    assert (counted.up, counted.flat, counted.down) == (2, 3, 1)


def test_breadth_treats_a_move_of_exactly_the_band_as_flat_despite_float_error() -> None:
    up_by_band = 100.05 / 100 - 1
    down_by_band = 99.95 / 100 - 1
    assert up_by_band != 0.0005 or down_by_band != -0.0005  # float error is real
    exact = breadth([up_by_band, down_by_band, 0.0005, -0.0005])
    assert (exact.up, exact.flat, exact.down) == (0, 4, 0)
    beyond = breadth([0.0005 + 2e-9, -0.0005 - 2e-9])
    assert (beyond.up, beyond.flat, beyond.down) == (1, 0, 1)


def test_competition_ranks_share_ties_and_skip_missing_values() -> None:
    assert competition_ranks({"a": 0.02, "b": 0.01, "c": 0.02, "d": None}) == {
        "a": 1,
        "b": 3,
        "c": 1,
        "d": None,
    }


def test_top_streak_counts_latest_consecutive_top_three_ranks() -> None:
    assert top_streak([8, 2, 3, 1, 2]) == 4
    assert top_streak([1, 1, 4, 1]) == 1
    assert top_streak([1, 2, None]) == 0
    assert top_streak([]) == 0


def test_board_times_and_as_of() -> None:
    first = session(10.0, (0, 10.0), (5, 10.5))
    second = session(20.0, (5, 21.0), (12.25, 22.0))

    assert board_times([first, second]) == [at(0), at(5), at(10)]
    assert board_as_of([first, second], at(30)) == at(12.25)
    assert board_as_of([first, second], at(11)) == at(11)
    assert board_as_of([first, second], at(30), at(12)) == at(12)
    assert board_as_of([], at(11)) is None


def test_board_as_of_reads_a_closing_auction_print_as_the_close() -> None:
    auction = member_session(
        [stamp(385), stamp(395.5)], [10.0, 10.4], 10.0, session_open=OPEN, session_close=CLOSE
    )
    assert auction is not None
    assert auction.times == (at(385), CLOSE)
    assert auction.closes == (10.0, 10.4)
    assert auction.observed_at == CLOSE + timedelta(minutes=5.5)
    assert board_as_of([auction], CLOSE + timedelta(minutes=30), CLOSE) == CLOSE


def test_build_grouping_weights_paths_breadth_leaders_and_subgroups() -> None:
    sessions = {
        "AAA": session(100.0, (0, 101.0), (5, 102.0)),  # +2%
        "BBB": session(50.0, (5, 49.0)),  # -2%, first trade in the second bucket
        "CCC": session(10.0, (0, 10.0)),  # unchanged
    }
    members = [
        BoardMember("AAA", "Alpha", "45", 3.0, subgroup="4530", exposure_gbp=120.0),
        BoardMember("BBB", "Beta", "45", 1.0, subgroup="4520", research_ticker="BBB"),
        BoardMember("CCC", "Gamma", "40", 4.0, exposure_gbp=5.0),
        BoardMember("DDD", "Delta", "40", 2.0),  # never priced
    ]
    times = board_times(sessions.values())

    grouping = build_grouping(
        "gics",
        [GroupLabel("40", "Financials"), GroupLabel("45", "Information Technology")],
        members,
        sessions,
        times=times,
        subgroup_names={"4530": "Semiconductors & Semiconductor Equipment"},
    )

    financials, technology = grouping.groups
    assert grouping.kind == "gics"
    assert technology.change == pytest.approx((3 * 0.02 + 1 * -0.02) / 4)
    assert technology.weight == pytest.approx(0.4)
    assert financials.weight == pytest.approx(0.6)
    # The path averages each member's latest price, unchanged before its first trade.
    assert technology.path == pytest.approx([3 * 0.01 / 4, technology.change])
    assert technology.path[-1] == pytest.approx(technology.change)
    assert (technology.breadth.up, technology.breadth.flat, technology.breadth.down) == (1, 0, 1)
    assert technology.leader is not None and technology.leader.symbol == "AAA"
    assert technology.exposure_gbp == 120.0
    assert [member.symbol for member in technology.members] == ["AAA", "BBB"]
    assert technology.members[1].research_ticker == "BBB"
    assert [(sub.key, sub.name) for sub in technology.subgroups] == [
        ("4520", "4520"),
        ("4530", "Semiconductors & Semiconductor Equipment"),
    ]
    assert technology.subgroups[1].change == pytest.approx(0.02)
    assert technology.subgroups[1].weight == pytest.approx(0.3)
    # An unpriced member counts toward membership and weight, not breadth.
    assert financials.member_count == 2
    assert financials.change == pytest.approx(0.0)
    assert (financials.breadth.up, financials.breadth.flat, financials.breadth.down) == (0, 1, 0)
    assert financials.members[1].symbol == "DDD" and financials.members[1].change is None
    assert financials.subgroups == []


def test_build_grouping_ranks_sessions_from_daily_closes_and_the_live_change() -> None:
    daily_sessions = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]
    daily = {
        "UP": {"2026-11-02": 10.0, "2026-11-03": 11.0, "2026-11-04": 12.0, "2026-11-05": 13.0},
        "DOWN": {"2026-11-02": 10.0, "2026-11-03": 9.0, "2026-11-04": 9.5, "2026-11-05": 9.0},
        "MID": {"2026-11-02": 10.0, "2026-11-03": 10.1, "2026-11-04": 9.0},
    }
    sessions = {
        "UP": session(13.0, (0, 13.13)),
        "DOWN": session(9.0, (0, 9.45)),
        "MID": session(9.0, (0, 9.0)),
    }
    grouping = build_grouping(
        "gics",
        [GroupLabel("a", "A"), GroupLabel("b", "B"), GroupLabel("c", "C")],
        [
            BoardMember("UP", "Up", "a", 1.0),
            BoardMember("DOWN", "Down", "b", 1.0),
            BoardMember("MID", "Mid", "c", 1.0),
        ],
        sessions,
        times=board_times(sessions.values()),
        daily=daily,
        daily_sessions=daily_sessions,
    )

    ranks = {group.key: group.ranks for group in grouping.groups}
    streaks = {group.key: group.streak for group in grouping.groups}
    assert ranks == {
        "a": [1, 1, 1, 2],
        "b": [3, 2, 2, 1],
        "c": [2, 3, None, 3],
    }
    assert streaks == {"a": 4, "b": 4, "c": 1}


def test_build_grouping_without_daily_history_ranks_only_the_session() -> None:
    sessions = {"X": session(10.0, (0, 10.5)), "Y": session(10.0, (0, 9.5))}
    grouping = build_grouping(
        "gics",
        [GroupLabel("x", "X"), GroupLabel("y", "Y")],
        [BoardMember("X", "X", "x", 1.0), BoardMember("Y", "Y", "y", 1.0)],
        sessions,
        times=board_times(sessions.values()),
    )
    assert [(group.ranks, group.streak) for group in grouping.groups] == [([1], 1), ([2], 1)]


def test_build_grouping_drops_thin_groups_before_weighting_the_rest() -> None:
    sessions = {name: session(10.0, (0, 10.1)) for name in ("A", "B", "C", "D")}
    members = [
        BoardMember("A", "A", "big", 1.0),
        BoardMember("B", "B", "big", 1.0),
        BoardMember("C", "C", "big", 2.0),
        BoardMember("D", "D", "thin", 4.0),
        BoardMember("E", "E", "thin", 4.0),
        BoardMember("F", "F", "thin", 4.0),
    ]

    grouping = build_grouping(
        "themes",
        [GroupLabel("big", "Big", "大"), GroupLabel("thin", "Thin")],
        members,
        sessions,
        times=board_times(sessions.values()),
        min_priced=3,
    )

    assert [group.key for group in grouping.groups] == ["big"]
    assert grouping.groups[0].weight == pytest.approx(1.0)
    assert grouping.groups[0].name_zh == "大"
    assert [member.weight for member in grouping.groups[0].members] == pytest.approx(
        [0.5, 0.25, 0.25]
    )


def test_build_grouping_uses_equal_weights_when_no_member_has_weight() -> None:
    sessions = {"A": session(10.0, (0, 11.0)), "B": session(10.0, (0, 10.0))}
    grouping = build_grouping(
        "themes",
        [GroupLabel("g", "G")],
        [BoardMember("A", "A", "g", 0.0), BoardMember("B", "B", "g", 0.0)],
        sessions,
        times=board_times(sessions.values()),
    )
    assert grouping.groups[0].change == pytest.approx(0.05)
    assert grouping.groups[0].weight == 0.0


def test_rankable_needs_half_the_weight_and_enough_members() -> None:
    members = [BoardMember("A", "A", "g", 3.0), BoardMember("B", "B", "g", 1.0)]
    assert rankable(members, members[:1])
    assert not rankable(members, members[1:])
    assert not rankable(members, members, min_members=3)
    unweighted = [BoardMember("A", "A", "g", 0.0), BoardMember("B", "B", "g", 0.0)]
    assert rankable(unweighted, unweighted[:1])
    assert not rankable(members, [])


def test_thinly_priced_groups_are_not_ranked_in_any_session() -> None:
    daily_sessions = ["2026-11-04", "2026-11-05"]
    daily = {
        # Only the light member of "thin" has closes; "deep" is fully covered.
        "T2": {"2026-11-04": 10.0, "2026-11-05": 13.0},
        "D1": {"2026-11-04": 10.0, "2026-11-05": 10.1},
    }
    sessions = {
        "T2": session(10.0, (0, 13.0)),  # +30%, but a tenth of its group
        "D1": session(10.0, (0, 10.1)),
    }
    grouping = build_grouping(
        "gics",
        [GroupLabel("thin", "Thin"), GroupLabel("deep", "Deep")],
        [
            BoardMember("T1", "T1", "thin", 9.0),
            BoardMember("T2", "T2", "thin", 1.0),
            BoardMember("D1", "D1", "deep", 5.0),
        ],
        sessions,
        times=board_times(sessions.values()),
        daily=daily,
        daily_sessions=daily_sessions,
    )

    thin, deep = grouping.groups
    assert thin.change == pytest.approx(0.3)  # still shown
    assert thin.ranks == [None, None]
    assert thin.streak == 0
    assert deep.ranks == [1, 1]


def test_theme_history_needs_three_members_with_closes() -> None:
    daily_sessions = ["2026-11-04", "2026-11-05"]
    full = {"2026-11-04": 10.0, "2026-11-05": 11.0}
    daily = {"A": full, "B": full, "C": {"2026-11-05": 11.0}, "X": full, "Y": full, "Z": full}
    sessions = {name: session(10.0, (0, 10.5)) for name in ("A", "B", "C", "X", "Y", "Z")}
    grouping = build_grouping(
        "themes",
        [GroupLabel("abc", "ABC"), GroupLabel("xyz", "XYZ")],
        [BoardMember(name, name, "abc", 1.0) for name in ("A", "B", "C")]
        + [BoardMember(name, name, "xyz", 1.0) for name in ("X", "Y", "Z")],
        sessions,
        times=board_times(sessions.values()),
        daily=daily,
        daily_sessions=daily_sessions,
        min_priced=3,
    )
    ranks = {group.key: group.ranks for group in grouping.groups}
    # Two of three members with closes cover the weight, but not the member rule.
    assert ranks == {"abc": [None, 1], "xyz": [1, 1]}


def test_after_the_close_only_closing_prices_rank_a_group() -> None:
    sessions = {
        # Energy stopped printing at the open, up 10%.
        "E1": session(10.0, (0, 11.0)),
        "E2": session(10.0, (0, 11.0)),
        "T1": session(10.0, (0, 10.0), (390, 10.2)),  # a print at the close
        "F1": session(10.0, (385, 9.9)),  # the last bucket before it
    }
    labels = [GroupLabel("10", "Energy"), GroupLabel("45", "IT"), GroupLabel("40", "Fin")]
    members = [
        BoardMember("E1", "E1", "10", 1.0),
        BoardMember("E2", "E2", "10", 1.0),
        BoardMember("T1", "T1", "45", 6.0),
        BoardMember("F1", "F1", "40", 2.0),
    ]
    times = board_times(sessions.values())

    live = build_grouping("gics", labels, members, sessions, times=times)
    assert [group.ranks for group in live.groups] == [[1], [2], [3]]

    final = build_grouping("gics", labels, members, sessions, times=times, final_close=CLOSE)
    energy, technology, financials = final.groups
    assert energy.change == pytest.approx(0.1)  # still shown
    assert (energy.ranks, energy.streak) == ([None], 0)
    assert (technology.ranks, financials.ranks) == ([1], [2])

    # Themes need three members priced at the close, whatever weight two cover.
    theme_sessions = {
        "A": session(10.0, (390, 10.3)),
        "B": session(10.0, (390, 10.1)),
        "C": session(10.0, (0, 12.0)),  # stopped at the open
        **{name: session(10.0, (390, 10.2)) for name in ("X", "Y", "Z")},
    }
    themes = build_grouping(
        "themes",
        [GroupLabel("abc", "ABC"), GroupLabel("xyz", "XYZ")],
        [BoardMember(name, name, "abc", 1.0) for name in ("A", "B", "C")]
        + [BoardMember(name, name, "xyz", 1.0) for name in ("X", "Y", "Z")],
        theme_sessions,
        times=board_times(theme_sessions.values()),
        min_priced=3,
        final_close=CLOSE,
    )
    assert {group.key: group.ranks for group in themes.groups} == {"abc": [None], "xyz": [1]}


def test_after_the_close_a_group_ranks_on_its_closing_return_alone() -> None:
    sessions = {
        "A1": session(10.0, (390, 10.1)),  # 85% of its group, +1% at the close
        "A2": session(10.0, (0, 11.0)),  # a stale opening quote, +10%
        "B1": session(10.0, (390, 10.2)),
        "C1": session(10.0, (390, 10.15)),
        "D1": session(10.0, (390, 10.12)),
    }
    labels = [GroupLabel(key, key.upper()) for key in ("a", "b", "c", "d")]
    members = [
        BoardMember("A1", "A1", "a", 85.0),
        BoardMember("A2", "A2", "a", 15.0),
        BoardMember("B1", "B1", "b", 100.0),
        BoardMember("C1", "C1", "c", 100.0),
        BoardMember("D1", "D1", "d", 100.0),
    ]
    times = board_times(sessions.values())

    # During the session the latest prices rank, the stale quote included.
    live = build_grouping("gics", labels, members, sessions, times=times)
    assert [group.ranks for group in live.groups] == [[1], [2], [3], [4]]

    final = build_grouping("gics", labels, members, sessions, times=times, final_close=CLOSE)
    a, b, _, _ = final.groups
    assert a.change == pytest.approx(0.85 * 0.01 + 0.15 * 0.10)  # shown as before
    # Ranked on its closing +1%, below the groups closing +2%, +1.5% and +1.2%.
    assert [group.ranks for group in final.groups] == [[4], [1], [2], [3]]
    assert (a.streak, b.streak) == (0, 1)


def test_partly_classified_groups_list_the_rest_as_other() -> None:
    sessions = {
        "A": session(10.0, (0, 10.2)),
        "B": session(10.0, (0, 9.9)),
        "C": session(10.0, (0, 10.1)),
    }
    grouping = build_grouping(
        "gics",
        [GroupLabel("45", "IT"), GroupLabel("40", "Fin"), GroupLabel("20", "Ind")],
        [
            BoardMember("A", "A", "45", 2.0, subgroup="4530", exposure_gbp=5.0),
            BoardMember("B", "B", "45", 6.0, exposure_gbp=7.0),
            BoardMember("U", "U", "45", 2.0),  # unclassified and unpriced
            BoardMember("C", "C", "40", 1.0),
            BoardMember("D", "D", "20", 1.0, subgroup="2010"),
        ],
        sessions,
        times=board_times(sessions.values()),
        subgroup_names={"4530": "Semiconductors", "2010": "Capital Goods"},
    )

    technology, financials, industrials = grouping.groups
    assert [(sub.key, sub.name) for sub in technology.subgroups] == [
        ("4530", "Semiconductors"),
        ("", ""),
    ]
    other = technology.subgroups[1]
    assert other.member_count == 2
    assert other.weight == pytest.approx(8 / 12)
    assert other.change == pytest.approx(-0.01)
    assert (other.breadth.up, other.breadth.flat, other.breadth.down) == (0, 0, 1)
    assert other.exposure_gbp == 7.0
    assert sum(sub.weight for sub in technology.subgroups) == pytest.approx(technology.weight)
    assert financials.subgroups == []  # nothing classified
    assert [sub.key for sub in industrials.subgroups] == ["2010"]  # nothing unclassified


def test_settle_ends_a_session_on_the_official_close() -> None:
    intraday = session(100.0, (0, 101.0), (380, 104.0))  # bars stop at 20:50
    assert not closes_at_close(intraday, CLOSE)

    settled = settle(intraday, 103.0, 99.0, session_close=CLOSE)
    assert settled is not None
    assert settled.times == (at(0), at(380), CLOSE)
    assert settled.closes == (101.0, 104.0, 103.0)
    assert settled.previous_close == 100.0  # the intraday base stands
    assert settled.change == pytest.approx(0.03)
    assert settled.observed_at == CLOSE
    assert closes_at_close(settled, CLOSE)

    replaced = settle(session(100.0, (390, 102.0)), 103.0, None, session_close=CLOSE)
    assert replaced is not None and replaced.closes == (103.0,)

    alone = settle(None, 50.0, 40.0, session_close=CLOSE)
    assert alone is not None
    assert (alone.times, alone.change) == ((CLOSE,), pytest.approx(0.25))
    assert settle(None, 50.0, None, session_close=CLOSE) is None
    assert settle(intraday, None, 99.0, session_close=CLOSE) is intraday
    assert closes_at_close(session(100.0, (385, 101.0)), CLOSE)
