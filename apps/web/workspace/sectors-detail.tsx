"use client";

import { CaretRight } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { SectorBoard, SectorBreadth, SectorGroup, SectorGroupingKind, SectorMember, SectorSessionWindow } from "@/lib/types";
import { formatCalendarDate, formatDate, formatDeltaPercent } from "@/ui/formatters";
import { currency, percent } from "@/workspace/data";
import { industryName } from "./exposure-names";
import { useCopy } from "./foundation";
import Link from "./link";
import { changeTone, groupName } from "./sectors-map";
import { byStanding, displaySymbol, issuerName, sessionPosition, sparkline } from "./sectors-data";

const MEMBERS_SHOWN = 8;

function sessionFor(board: SectorBoard, sessions: ReadonlyArray<SectorSessionWindow>) {
  return sessions.find((session) => session.date === board.sessionDate) ?? null;
}

function positions(board: SectorBoard, session: SectorSessionWindow | null) {
  return session
    ? board.times.map((time) => sessionPosition(session, time))
    : board.times.map((_, index, all) => (all.length > 1 ? index / (all.length - 1) : 0));
}

function byChange<T extends { change?: number | null }>(a: T, b: T) {
  return (b.change ?? -Infinity) - (a.change ?? -Infinity);
}

function BreadthBar({ breadth }: { breadth: SectorBreadth }) {
  return (
    <span className="mx-sector-breadth-bar" aria-hidden="true">
      <i data-tone="up" style={{ flexGrow: breadth.up }} />
      <i data-tone="flat" style={{ flexGrow: breadth.flat }} />
      <i data-tone="down" style={{ flexGrow: breadth.down }} />
    </span>
  );
}

function SymbolLink({ member, symbol }: { member?: SectorMember; symbol: string }) {
  const label = displaySymbol(symbol);
  return member?.researchTicker
    ? <Link href={"/research?ticker=" + encodeURIComponent(member.researchTicker)} className="mx-sector-symbol">{label}</Link>
    : <span className="mx-sector-symbol">{label}</span>;
}

export function SectorDetail({ group, board, sessions, kind, openSubgroup, focusOnOpen = false }: {
  group: SectorGroup;
  board: SectorBoard;
  sessions: ReadonlyArray<SectorSessionWindow>;
  kind: SectorGroupingKind;
  openSubgroup: string | null;
  /** A phone step takes focus, since the row that opened it is gone. */
  focusOnOpen?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnOpen) heading.current?.focus({ preventScroll: true });
  }, [focusOnOpen]);
  const name = groupName(group, kind, locale);
  const tone = changeTone(group.change);
  const leader = group.leader;
  const leaderMember = leader ? group.members.find((member) => member.symbol === leader.symbol) : undefined;
  const share = board.exposureBasisGbp ? group.exposureGbp / board.exposureBasisGbp : null;
  const { up, flat, down } = group.breadth;
  return (
    <section className="mx-panel mx-sector-detail" aria-label={name}>
      <header className="mx-sector-detail-head">
        <h2 ref={heading} tabIndex={-1}>{name}</h2>
        <strong className={"mx-sector-detail-change mx-" + tone}>{formatDeltaPercent(group.change, locale, 2)}</strong>
      </header>
      <SectorSpark group={group} board={board} session={sessionFor(board, sessions)} />
      <dl className="mx-sector-facts">
        <div>
          <dt>{t("涨跌家数", "Breadth")}</dt>
          <dd className="mx-sector-breadth-detail">
            <BreadthBar breadth={group.breadth} />
            <span>
              <span className="mx-up">{t("涨", "Up")} {up}</span>
              {flat > 0 && <span>{t("平", "Flat")} {flat}</span>}
              <span className="mx-down">{t("跌", "Down")} {down}</span>
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("领涨", "Leader")}</dt>
          <dd className="mx-sector-leader">
            {leader ? (
              <>
                <SymbolLink member={leaderMember} symbol={leader.symbol} />
                <span className={"mx-" + changeTone(leader.change)}>{formatDeltaPercent(leader.change, locale, 2)}</span>
                <span className="mx-sector-leader-name">{issuerName(leader.name)}</span>
              </>
            ) : "—"}
          </dd>
        </div>
        <div>
          <dt>{t("近 5 日排名", "Last 5 sessions")}</dt>
          <dd className="mx-sector-ranks-cell">
            <ol className="mx-sector-ranks">
              {group.ranks.map((rank, index) => (
                <li key={index} data-top={rank != null && rank <= 3 ? "" : undefined}
                  data-today={index === group.ranks.length - 1 ? "" : undefined}
                  title={board.rankSessions[index] ? formatCalendarDate(board.rankSessions[index], locale) : undefined}>
                  {rank ?? "–"}
                </li>
              ))}
            </ol>
            {group.streak >= 2 && (
              <span>{locale === "zh" ? `连续 ${group.streak} 日前三` : `Top three ${group.streak} sessions running`}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("你的持仓", "Your exposure")}</dt>
          <dd>
            {share == null ? "—" : group.exposureGbp > 0
              ? currency(group.exposureGbp, "GBP", 0) + " · " + percent(share, false, 1)
              : <span className="mx-muted">{t("未持有", "None")}</span>}
          </dd>
        </div>
      </dl>
      {kind === "gics" && group.subgroups.length > 0
        ? <Subgroups key={openSubgroup === null ? "closed" : "open:" + openSubgroup} group={group} openSubgroup={openSubgroup} />
        : <Members members={group.members} />}
    </section>
  );
}

function SectorSpark({ group, board, session }: { group: SectorGroup; board: SectorBoard; session: SectorSessionWindow | null }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const width = 320;
  const height = 112;
  const line = sparkline(group.path, positions(board, session), width, height, 10);
  const clock = (value: string | undefined) =>
    value ? formatDate(value, locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }) : "";
  const start = session?.open ?? board.times[0];
  const end = session?.close ?? board.times.at(-1);
  const tone = changeTone(line.last?.value ?? group.change);
  // The session's best point whatever its sign: on a down day the high is still worth knowing.
  const high = line.peak;
  const highTone = changeTone(high?.value);
  if (!line.path) {
    return (
      <figure className="mx-sector-spark">
        <div className="mx-sector-spark-plot mx-sector-spark-empty">{t("暂无日内走势", "No intraday prices yet")}</div>
      </figure>
    );
  }
  return (
    <figure className="mx-sector-spark">
      <div className="mx-sector-spark-plot">
        <svg viewBox={"0 0 " + width + " " + height} preserveAspectRatio="none" role="img"
          aria-label={t("日内走势", "Intraday") + (high ? t("，最高 ", ", high ") + formatDeltaPercent(high.value, locale, 2) : "")}>
          <line x1={0} x2={width} y1={line.zero} y2={line.zero} className="mx-sector-spark-zero" vectorEffect="non-scaling-stroke" />
          <path d={line.path} className={"mx-sector-spark-line mx-" + tone} vectorEffect="non-scaling-stroke" />
        </svg>
        {high && (
          <span className="mx-sector-spark-peak" data-tone={highTone}
            style={{ left: (high.x / width) * 100 + "%", top: (high.y / height) * 100 + "%" }} />
        )}
      </div>
      <figcaption className="mx-sector-spark-axis">
        <span>{clock(start)}</span>
        {high && (
          <span className="mx-sector-spark-high" data-tone={highTone}>{t("最高 ", "High ") + formatDeltaPercent(high.value, locale, 2)}</span>
        )}
        <span>{clock(end)}</span>
      </figcaption>
    </figure>
  );
}

function Subgroups({ group, openSubgroup }: { group: SectorGroup; openSubgroup: string | null }) {
  const t = useCopy();
  const { locale } = useLocale();
  // A tile click remounts the list (keyed by the group it opened) with that group expanded.
  const [open, setOpen] = useState<string | null>(openSubgroup);
  return (
    <ul className="mx-sector-subgroups">
      {/* Industry groups by their move; the unclassified rest closes the list. */}
      {[...group.subgroups].sort((a, b) => Number(a.key === "") - Number(b.key === "") || byChange(a, b)).map((subgroup) => {
        const name = subgroup.key ? industryName(subgroup.name, locale) : t("其他", "Other");
        const expanded = open === subgroup.key;
        return (
          <li key={subgroup.key}>
            <button type="button" className="mx-sector-subgroup" aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : subgroup.key)}>
              <CaretRight size={14} aria-hidden="true" />
              <span className="mx-sector-subgroup-name">{name}</span>
              {subgroup.exposureGbp > 0 && <span className="mx-sector-held">{currency(subgroup.exposureGbp, "GBP", 0)}</span>}
              <span className={"mx-sector-subgroup-change mx-" + changeTone(subgroup.change)}>
                {formatDeltaPercent(subgroup.change, locale, 2)}
              </span>
            </button>
            {expanded && <Members members={group.members.filter((member) => member.subgroup === subgroup.key)} />}
          </li>
        );
      })}
    </ul>
  );
}

function Members({ members }: { members: SectorMember[] }) {
  const t = useCopy();
  const { locale } = useLocale();
  const [all, setAll] = useState(false);
  const sorted = [...members].sort(byChange);
  const shown = all ? sorted : sorted.slice(0, MEMBERS_SHOWN);
  return (
    <div className="mx-sector-members">
      <ul>
        {shown.map((member) => (
          <li key={member.symbol}>
            <SymbolLink member={member} symbol={member.symbol} />
            <span className="mx-sector-member-name">{issuerName(member.name)}</span>
            {member.exposureGbp > 0 && <span className="mx-sector-held">{currency(member.exposureGbp, "GBP", 0)}</span>}
            <span className={"mx-sector-member-change mx-" + changeTone(member.change)}>
              {formatDeltaPercent(member.change, locale, 2)}
            </span>
          </li>
        ))}
      </ul>
      {sorted.length > MEMBERS_SHOWN && (
        <button type="button" className="mx-sector-more" onClick={() => setAll(!all)}>
          {all ? t("收起", "Show fewer") : locale === "zh" ? `显示全部 ${sorted.length} 只` : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

export function SectorList({ groups, board, sessions, kind, focusKey, onFocused, onOpen }: {
  groups: SectorGroup[];
  board: SectorBoard;
  sessions: ReadonlyArray<SectorSessionWindow>;
  kind: SectorGroupingKind;
  /** The row a closed sector returns focus to. */
  focusKey: string | null;
  /** The return target is spent once focus lands, so a later market switch moves nothing. */
  onFocused: () => void;
  onOpen: (key: string) => void;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const list = useRef<HTMLOListElement>(null);
  const focused = useEffectEvent(() => onFocused());
  useEffect(() => {
    if (!focusKey) return;
    list.current?.querySelector<HTMLButtonElement>('[data-key="' + CSS.escape(focusKey) + '"]')?.focus({ preventScroll: true });
    focused();
  }, [focusKey]);
  const session = sessionFor(board, sessions);
  const spots = positions(board, session);
  return (
    <ol ref={list} className="mx-panel mx-sector-list">
      {[...groups].sort(byStanding).map((group) => {
        const name = groupName(group, kind, locale);
        const tone = changeTone(group.change);
        const line = sparkline(group.path, spots, 72, 26, 3);
        const { up, down } = group.breadth;
        return (
          <li key={group.key}>
            <button type="button" data-key={group.key} onClick={() => onOpen(group.key)}>
              <span className="mx-sector-list-name">{name}</span>
              <svg className="mx-sector-list-spark" viewBox="0 0 72 26" aria-hidden="true">
                <line x1={0} x2={72} y1={line.zero} y2={line.zero} className="mx-sector-spark-zero" />
                <path d={line.path} className={"mx-sector-spark-line mx-" + tone} />
              </svg>
              <span className={"mx-sector-list-change mx-" + tone}>{formatDeltaPercent(group.change, locale, 2)}</span>
              <span className="mx-sector-list-meta">
                <BreadthBar breadth={group.breadth} />
                <span>{t("涨", "Up")} {up} · {t("跌", "Down")} {down}</span>
                {group.streak >= 2 && <span className="mx-sector-streak">{locale === "zh" ? `连${group.streak}日前三` : `Top 3 · ${group.streak}d`}</span>}
                {group.leader && (
                  <span className="mx-sector-list-leader">
                    {displaySymbol(group.leader.symbol) + " " + formatDeltaPercent(group.leader.change, locale, 2)}
                  </span>
                )}
              </span>
              <CaretRight size={16} className="mx-sector-list-caret" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
