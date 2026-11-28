"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
import type { SectorBoard, SectorBreadth, SectorGroup, SectorGroupingKind, SectorMember, SectorSessionWindow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatCalendarDate, formatDate, formatDeltaPercent } from "@/ui/formatters";
import { currency, percent } from "@/workspace/data";
import { industryName } from "./exposure-names";
import { useCopy } from "./foundation";
import Link from "./link";
import { PageInspection } from "./assistant/inspection-entry";
import { changeTone, groupName } from "./sectors-map";
import { byStanding, displaySymbol, issuerName, sessionPosition, sparkline } from "./sectors-data";

const MEMBERS_SHOWN = 8;
export type SectorDetailBoard = Pick<SectorBoard, "sessionDate" | "times" | "rankSessions" | "exposureBasisGbp">;

function sessionFor(board: SectorDetailBoard, sessions: ReadonlyArray<SectorSessionWindow>) {
  return sessions.find((session) => session.date === board.sessionDate) ?? null;
}

function positions(board: SectorDetailBoard, session: SectorSessionWindow | null) {
  return session
    ? board.times.map((time) => sessionPosition(session, time))
    : board.times.map((_, index, all) => (all.length > 1 ? index / (all.length - 1) : 0));
}

function byChange<T extends { change?: number | null }>(a: T, b: T) {
  return (b.change ?? -Infinity) - (a.change ?? -Infinity);
}

function BreadthBar({ breadth, className }: { breadth: SectorBreadth; className?: string }) {
  return (
    <span className={cn("mx-sector-breadth-bar flex gap-px overflow-clip rounded-[3px]", className)} aria-hidden="true">
      <i data-tone="up" className="block min-w-0 bg-gain" style={{ flexGrow: breadth.up }} />
      <i data-tone="flat" className="block min-w-0 bg-border" style={{ flexGrow: breadth.flat }} />
      <i data-tone="down" className="block min-w-0 bg-loss" style={{ flexGrow: breadth.down }} />
    </span>
  );
}

function SymbolLink({ member, symbol }: { member?: SectorMember; symbol: string }) {
  const label = displaySymbol(symbol);
  return member?.researchTicker
    ? <Link href={"/research?ticker=" + encodeURIComponent(member.researchTicker)} className="mx-sector-symbol">{label}</Link>
    : <span className="mx-sector-symbol">{label}</span>;
}

export function SectorDetail({ group, board, sessions, kind, openSubgroup, focusOnOpen = false, indexFacts, context, inspection }: {
  group: SectorGroup;
  board: SectorDetailBoard;
  sessions: ReadonlyArray<SectorSessionWindow>;
  kind: SectorGroupingKind;
  openSubgroup: string | null;
  /** A phone step takes focus, since the row that opened it is gone. */
  focusOnOpen?: boolean;
  indexFacts?: ReactNode;
  context?: ReactNode;
  inspection?: { market:string; observed:string; selected:boolean; worldFigures?: readonly (number | string | boolean | null)[] };
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
    <Card as="section" className="mx-sector-detail flex flex-col gap-[18px] max-[767px]:gap-3" aria-label={name}>
      <header className="mx-sector-detail-head flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 ref={heading} tabIndex={-1}>{name}</h2>
        <strong className={"mx-sector-detail-change text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.02em] max-[767px]:text-2xl mx-" + tone}>{indexFacts && group.change == null ? t("无报价", "No quote") : formatDeltaPercent(group.change, locale, 2)}</strong>
        {context}
      </header>
      {inspection && <PageInspection role="market-sector" object={name}
        context={inspection.selected ? {market:inspection.market,observed:inspection.observed,grouping:kind,sector:group.key} : undefined}
        liveRecord={{observed:inspection.observed, heading, figures:[
          board.sessionDate, group.name, group.change ?? null,
          ...(inspection.worldFigures ?? [up, flat, down, share === null ? null : group.exposureGbp]),
        ]}} />}
      <SectorSpark group={group} board={board} session={sessionFor(board, sessions)} omitEmpty={Boolean(indexFacts)} />
      {indexFacts ?? <>
      <dl className="mx-sector-facts">
        <div>
          <dt>{t("涨跌家数", "Breadth")}</dt>
          <dd className="mx-sector-breadth-detail">
            <BreadthBar breadth={group.breadth} className="h-1.5" />
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
                <span className="mx-sector-leader-name min-w-0 basis-full truncate text-muted-foreground">{issuerName(leader.name)}</span>
              </>
            ) : "—"}
          </dd>
        </div>
        <div>
          <dt>{t("近 5 日排名", "Last 5 sessions")}</dt>
          <dd className="mx-sector-ranks-cell">
            <SectorRanks ranks={group.ranks} days={board.rankSessions} markLast />
            {group.streak >= 2 && (
              <span className="text-[12px] text-muted-foreground">{locale === "zh" ? `连续 ${group.streak} 日前三` : `Top three ${group.streak} sessions running`}</span>
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
      </>}
    </Card>
  );
}

export function SectorRanks({ ranks, days, markLast }: {
  ranks: Array<number | null>;
  days: string[];
  markLast?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  return <ol className="mx-sector-ranks flex w-full list-none flex-wrap gap-1 p-0">
    {Array.from({ length: Math.max(ranks.length, days.length) }, (_, index) => {
      const rank = ranks[index];
      const day = days[index];
      const top = rank != null && rank <= 3;
      return <li key={day ?? index} className="grid justify-items-center text-xs tabular-nums"
        data-top={top || undefined} data-today={markLast && index === ranks.length - 1 ? "" : undefined}>
        {day && <time className="text-muted-foreground" dateTime={day} aria-label={formatCalendarDate(day, locale)}>{formatDate(day, locale, { month: "numeric", day: "numeric", timeZone: "UTC" })}</time>}
        <span className={cn("grid min-h-6 min-w-6 place-items-center rounded-full px-1 font-semibold",
          top ? "bg-foreground text-card" : "bg-muted text-muted-foreground")}>
          {rank ?? <><span aria-hidden="true">–</span><span className="sr-only">{t("暂无排名", "No rank")}</span></>}
        </span>
      </li>;
    })}
  </ol>;
}

function SectorSpark({ group, board, session, omitEmpty }: { group: SectorGroup; board: SectorDetailBoard; session: SectorSessionWindow | null; omitEmpty: boolean }) {
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
    if (omitEmpty) return null;
    return (
      <figure className="mx-sector-spark m-0">
        <div className="mx-sector-spark-plot mx-sector-spark-empty relative grid h-28 place-items-center text-[13px] text-muted-foreground">
          {t("暂无日内走势", "No intraday prices yet")}
        </div>
      </figure>
    );
  }
  const peakBorder = highTone === "up" ? "border-gain" : highTone === "down" ? "border-loss" : "border-muted-foreground";
  return (
    <figure className="mx-sector-spark m-0">
      <div className="mx-sector-spark-plot relative h-28">
        <svg
          className="block size-full overflow-visible"
          viewBox={"0 0 " + width + " " + height}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("日内走势", "Intraday") + (high ? t("，最高 ", ", high ") + formatDeltaPercent(high.value, locale, 2) : "")}
        >
          <line
            x1={0}
            x2={width}
            y1={line.zero}
            y2={line.zero}
            className="mx-sector-spark-zero stroke-border [stroke-dasharray:3_3] [stroke-width:1]"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={line.path}
            className={cn(
              "mx-sector-spark-line fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.75]",
              "mx-" + tone,
            )}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {high && (
          <span
            className={cn(
              "mx-sector-spark-peak absolute -ml-[3.5px] -mt-[3.5px] size-[7px] rounded-full border-[1.5px] bg-card",
              peakBorder,
            )}
            data-tone={highTone}
            style={{ left: (high.x / width) * 100 + "%", top: (high.y / height) * 100 + "%" }}
          />
        )}
      </div>
      <figcaption className="mx-sector-spark-axis mt-1.5 flex justify-between text-[12px] text-muted-foreground">
        <span>{clock(start)}</span>
        {high && (
          <span className="mx-sector-spark-high inline-flex items-center gap-1.5" data-tone={highTone}>
            <i className={cn("size-[7px] rounded-full border-[1.5px]", peakBorder)} aria-hidden="true" />
            {t("最高 ", "High ") + formatDeltaPercent(high.value, locale, 2)}
          </span>
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
      {group.subgroups.toSorted((a, b) => Number(a.key === "") - Number(b.key === "") || byChange(a, b)).map((subgroup) => {
        const name = subgroup.key ? industryName(subgroup.name, locale) : t("其他", "Other");
        const expanded = open === subgroup.key;
        return (
          <li key={subgroup.key}>
            <Button variant="ghost" type="button" className="mx-sector-subgroup w-full justify-start px-0 text-left" aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : subgroup.key)}>
              <ChevronRight size={16} aria-hidden="true" />
              <span className="mx-sector-subgroup-name">{name}</span>
              {subgroup.exposureGbp > 0 && <span className="mx-sector-held text-xs text-muted-foreground">{currency(subgroup.exposureGbp, "GBP", 0)}</span>}
              <span className={"mx-sector-subgroup-change min-w-16 text-right font-semibold mx-" + changeTone(subgroup.change)}>
                {formatDeltaPercent(subgroup.change, locale, 2)}
              </span>
            </Button>
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
  const sorted = members.toSorted(byChange);
  const shown = all ? sorted : sorted.slice(0, MEMBERS_SHOWN);
  return (
    <div className="mx-sector-members">
      <ul>
        {shown.map((member) => (
          <li key={member.symbol}>
            <SymbolLink member={member} symbol={member.symbol} />
            <span className="mx-sector-member-name">{issuerName(member.name)}</span>
            {member.exposureGbp > 0 && <span className="mx-sector-held text-xs text-muted-foreground">{currency(member.exposureGbp, "GBP", 0)}</span>}
            <span className={"mx-sector-member-change min-w-16 text-right font-semibold mx-" + changeTone(member.change)}>
              {formatDeltaPercent(member.change, locale, 2)}
            </span>
          </li>
        ))}
      </ul>
      {sorted.length > MEMBERS_SHOWN && (
        <Button variant="link" type="button" className="mx-sector-more px-0" onClick={() => setAll(!all)}>
          {all ? t("收起", "Show fewer") : locale === "zh" ? `显示全部 ${sorted.length} 只` : `Show all ${sorted.length}`}
        </Button>
      )}
    </div>
  );
}

export function SectorList({ groups, board, sessions, kind, focusKey, onFocused, hrefFor, onOpen, indexOnly = false }: {
  groups: SectorGroup[];
  board: SectorDetailBoard;
  sessions: ReadonlyArray<SectorSessionWindow>;
  kind: SectorGroupingKind;
  /** The row a closed sector returns focus to. */
  focusKey: string | null;
  /** The return target is spent once focus lands, so a later market switch moves nothing. */
  onFocused: () => void;
  hrefFor: (key: string) => string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
  indexOnly?: boolean;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const list = useRef<HTMLOListElement>(null);
  const focused = useEffectEvent(() => onFocused());
  useEffect(() => {
    if (!focusKey) return;
    list.current?.querySelector<HTMLAnchorElement>('[data-key="' + CSS.escape(focusKey) + '"]')?.focus({ preventScroll: true });
    focused();
  }, [focusKey]);
  const session = sessionFor(board, sessions);
  const spots = positions(board, session);
  return (
    <ol ref={list} className="mx-panel mx-sector-list" data-index-only={indexOnly || undefined}>
      {groups.toSorted(indexOnly ? byChange : byStanding).map((group) => {
        const name = groupName(group, kind, locale);
        const tone = changeTone(group.change);
        const line = sparkline(group.path, spots, 72, 26, 3);
        const { up, down } = group.breadth;
        return (
          <li key={group.key}>
            <Link href={hrefFor(group.key)} prefetch={false} data-key={group.key} onClick={onOpen} data-slot="button"
              className={cn(
                buttonVariants({ variant: "ghost" }),
                "mx-sector-list-link grid w-full justify-normal gap-x-3 gap-y-1.5 rounded-[var(--radius-heat-tile)] px-0 py-3 text-left whitespace-normal",
                indexOnly ? "min-h-[52px] pointer-coarse:min-h-[52px]" : "min-h-16 pointer-coarse:min-h-16",
              )}>
              <span className="mx-sector-list-name line-clamp-2 min-w-0 text-[0.9375rem] leading-[1.3] font-semibold [grid-area:name]">{name}</span>
              {(!indexOnly || line.path) && (
                <svg className="mx-sector-list-spark h-[26px] w-[72px] overflow-visible [grid-area:spark] max-[359px]:hidden" viewBox="0 0 72 26" aria-hidden="true">
                  <line x1={0} x2={72} y1={line.zero} y2={line.zero} className="mx-sector-spark-zero stroke-border [stroke-dasharray:3_3] [stroke-width:1]" />
                  <path d={line.path} className={cn("mx-sector-spark-line fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.75]", "mx-" + tone)} />
                </svg>
              )}
              <span className={"mx-sector-list-change text-right text-[0.9375rem] font-semibold [overflow-wrap:anywhere] [grid-area:change] mx-" + tone}>{indexOnly && group.change == null ? t("无报价", "No quote") : formatDeltaPercent(group.change, locale, 2)}</span>
              {!indexOnly && <span className="mx-sector-list-meta flex min-w-0 items-center gap-2.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground [grid-area:meta]">
                <BreadthBar breadth={group.breadth} className="h-1 w-12 flex-none" />
                <span>{t("涨", "Up")} {up} · {t("跌", "Down")} {down}</span>
                {group.streak >= 2 && (
                  <span className="mx-sector-streak flex-none rounded bg-card px-1.5 text-xs font-semibold leading-4 text-foreground">
                    {locale === "zh" ? `连 ${group.streak} 日前三` : `Top 3 · ${group.streak}d`}
                  </span>
                )}
                {group.leader && (
                  <span className="mx-sector-list-leader min-w-0 truncate max-[359px]:hidden">
                    {displaySymbol(group.leader.symbol) + " " + formatDeltaPercent(group.leader.change, locale, 2)}
                  </span>
                )}
              </span>}
              <ChevronRight size={16} className="mx-sector-list-caret" aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
