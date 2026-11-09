"use client";

/*
 * Direction contract — 板块地图 (dealt index 5, seed a9911a9d), code-led.
 * THESIS: one market's sectors read like a map of today: area is market value,
 *   colour is the session's move, and every block already says how far it has gone.
 * OWN-WORLD: the Quiet Ledger, inherited unchanged — cool neutrals, ink figures,
 *   cobalt only for the selected block, green and red only for gains and losses.
 * STORY: pick a market (the open one is chosen for you) → scan the map → the
 *   strongest sector is already open beside it → follow an industry group to its
 *   companies → open one in research.
 * FIRST VIEWPORT: market switch with its session state and time; the sector map
 *   filling two thirds; the selected sector's intraday line, breadth, leader,
 *   five-session ranks and the owner's exposure in the rail. Phones get a ranked list.
 * SIGNATURE INTERACTION: selecting a block (pointer or arrow keys) moves the cobalt
 *   outline and the rail follows; a tile click also opens its industry group.
 * FORM: 板块地图, dealt index 5, seed a9911a9d (concept-seed --scope surface --mode operate
 *   --from a9911a9d reproduces DEALT INDICES 5, 4, 1). The round's record is
 *   .impeccable/mocks/decision/sectors-round.json (option "map", kicker THE ROLL, code-led).
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish
 *   review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
 */

import { Button } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowLeft } from "@phosphor-icons/react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { SectorBoardResponse, SectorGroupingKind, SectorMarketCode, SectorMarketStatus } from "@/lib/types";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { api } from "@/workspace/data";
import { Empty, Help, Page, Pending, QueryError, Segments, Tag, useCopy } from "./foundation";
import Link from "./link";
import { useRouteState } from "./route-state";
import { SectorDetail, SectorList } from "./sectors-detail";
import { SectorMap } from "./sectors-map";
import { SECTOR_MARKETS, marketPhase, sectorMarket, strongestGroup, type MarketPhase } from "./sectors-data";

/** Re-reads the clock each minute so session states turn without a refetch. */
function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function SectorsWorkspace() {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const { params, update } = useRouteState();
  const phone = useMediaQuery("(max-width: 767px)") ?? false;
  const now = useMinute();
  const requested = sectorMarket(params.get("market"));
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["workspace-sectors", requested ?? "default"],
    queryFn: async () => {
      const answer = await api<SectorBoardResponse>("/sectors" + (requested ? "?market=" + requested : ""));
      // The default answer also fills its market's own entry when that is still empty, so
      // naming the market in the URL (as selecting a sector does) reuses it rather than
      // starting over; a slower default answer never replaces a newer explicit one.
      const own = ["workspace-sectors", answer.market];
      if (!requested && client.getQueryData(own) === undefined) client.setQueryData(own, answer);
      return answer;
    },
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const data = query.data;
  // The last answer that carried its own market's board, whichever market that was.
  const [lastGood, setLastGood] = useState<SectorBoardResponse | null>(null);
  if (data?.board && data.board.market === data.market && !query.isPlaceholderData && data !== lastGood) setLastGood(data);
  // The URL answers at once on a switch; the server names the default market.
  const wanted: SectorMarketCode = requested ?? data?.market ?? "us";
  // The requested market has answered for itself, with a board or an honest empty one.
  const answered = !query.isPlaceholderData && data?.market === wanted;
  // A switch the server rejects falls back to the board already on screen, under its own
  // market's name, with a retry for the market that failed. The fallback stays while a
  // retry is in flight and gives way only to the requested market's own answer.
  const rejected = !answered && (query.isError || query.errorUpdatedAt > 0)
    && lastGood?.board != null && lastGood.market !== wanted;
  const shown = rejected ? lastGood : data;
  const market: SectorMarketCode = rejected && lastGood ? lastGood.market : wanted;
  // While another market loads, the previous answer still supplies sessions for
  // the switch, but its board is never shown under the new market's name.
  const board = shown?.board?.market === market ? shown.board : null;
  const switching = !rejected && Boolean(data?.board) && !board && query.isFetching;
  // A failed background refresh keeps the board on screen and says so beside its time.
  const refreshFailed = query.isError && board != null && !rejected;
  const status = shown?.markets.find((item) => item.market === market);
  const kinds = board?.groupings.map((grouping) => grouping.kind) ?? [];
  // The URL's grouping and sector belong to the requested market, so a fallback board ignores them.
  const kind: SectorGroupingKind = !rejected && params.get("grouping") === "themes" && kinds.includes("themes") ? "themes" : "gics";
  const groups = board?.groupings.find((grouping) => grouping.kind === kind)?.groups ?? [];
  const requestedSector = rejected ? null : params.get("sector");
  const explicit = requestedSector && groups.some((group) => group.key === requestedSector) ? requestedSector : null;
  const selected = explicit ?? strongestGroup(groups);
  const [subgroup, setSubgroup] = useState<{ group: string; key: string } | null>(null);
  // The phone row to return focus to after a sector closes.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  // Where the phone list was scrolled when a sector opened, restored when it closes.
  const listScroll = useRef(0);
  const names: Record<SectorMarketCode, string> = {
    us: t("美股", "US"),
    uk: t("英股", "UK"),
    hk: t("港股", "Hong Kong"),
    kr: t("韩股", "Korea"),
  };
  // Phone labels, so four markets keep one row at 320px in English too.
  const shortNames: Record<SectorMarketCode, string> = {
    us: t("美股", "US"),
    uk: t("英股", "UK"),
    hk: t("港股", "HK"),
    kr: t("韩股", "KR"),
  };
  const phases = Object.fromEntries((shown?.markets ?? []).map((item) => [item.market, marketPhase(item.sessions, item.timezone, now)]));
  const phaseName: Record<MarketPhase, string> = {
    open: t("盘中", "Open"),
    break: t("午休", "Lunch break"),
    closed: t("已收盘", "Closed"),
    "pre-open": t("未开盘", "Pre-open"),
    unknown: "",
  };
  const select = (key: string, opened?: string) => {
    // An "Other" tile opens with the empty key, so only a missing one means none.
    setSubgroup(opened !== undefined ? { group: key, key: opened } : null);
    if (!phone) {
      // The market rides along, so a shared link always names the board it came from.
      update({ market, sector: key });
      return;
    }
    // A phone opens a sector as its own history entry, marked so the page's Back
    // returns to the list (also after browser Back and Forward); a shared link
    // opened directly has no list behind it and closes in place instead.
    const next = new URLSearchParams(window.location.search);
    next.set("market", market);
    next.set("sector", key);
    listScroll.current = window.scrollY;
    window.history.pushState({ sectorDrill: true }, "", window.location.pathname + "?" + next.toString());
  };
  const marketSwitch = (
    <Segments
      label={t("市场", "Market")}
      value={market}
      shortcuts
      onChange={(value) => {
        // Asking again for the market that just failed retries it, once at a time.
        if (value === requested && (query.isError || rejected)) {
          if (!query.isFetching) void query.refetch();
        } else update({ market: value, sector: null });
      }}
      options={SECTOR_MARKETS.map((value) => ({
        value,
        label: names[value],
        short: shortNames[value] !== names[value] ? shortNames[value] : undefined,
        marker: phases[value]?.phase === "open" ? phaseName.open : undefined,
      }))}
    />
  );
  const groupingSwitch = kinds.includes("themes") && (
    <Segments
      label={t("分组", "Grouping")}
      value={kind}
      // The market rides along, so on a fallback board the switch returns to the board it shows.
      onChange={(value) => update({ market, grouping: value === "gics" ? null : value, sector: null })}
      options={[
        { value: "gics" as const, label: t("行业", "Sectors") },
        { value: "themes" as const, label: t("我的主题", "My themes") },
      ]}
    />
  );
  const clock = status && <SessionClock status={status} board={board} phase={phases[market]?.phase ?? "unknown"}
    phaseName={phaseName} monitorOn={shown?.monitor?.enabled !== false} refreshFailed={refreshFailed} now={now}
    retry={rejected ? {
      label: locale === "zh" ? `${names[wanted]}暂时无法读取 · 重试` : `${names[wanted]} unavailable · Retry`,
      busy: query.isFetching,
      run: () => void query.refetch(),
    } : undefined} />;
  const detail = selected ? groups.find((group) => group.key === selected) : undefined;
  // On a phone an opened sector is its own step: Back replaces the switches until it closes.
  const phoneDetail = phone && explicit && detail ? detail : null;
  const openedKey = phoneDetail?.key ?? null;
  // Whichever Back closes a sector (the page's or the browser's), focus returns to its row.
  const [shownKey, setShownKey] = useState<string | null>(null);
  if (openedKey !== shownKey) {
    setShownKey(openedKey);
    if (shownKey && !openedKey) setReturnTo(shownKey);
  }
  useEffect(() => {
    // Open at the top, with Back and the sector's name in view; return to the same place in the list.
    if (openedKey) window.scrollTo({ top: 0 });
    else if (listScroll.current) window.scrollTo({ top: listScroll.current });
  }, [openedKey]);
  const back = (
    <button type="button" className="mx-sector-back" onClick={() => {
      if ((window.history.state as { sectorDrill?: boolean } | null)?.sectorDrill) window.history.back();
      else update({ sector: null });
    }}>
      <ArrowLeft size={18} aria-hidden="true" />
      {names[market]}
    </button>
  );
  // A retry behind a fallback board is pending too, but the fallback stays on screen.
  const body = !rejected && (query.isPending || switching) ? (
    <Pending />
  ) : query.isError && !board ? (
    <QueryError retry={query.refetch} />
  ) : !board || !groups.length ? (
    <section className="mx-panel">
      <Empty
        title={locale === "zh" ? `还没有${names[market]}板块数据` : `No ${names[market]} sector data yet`}
        description={data?.monitor?.enabled === false
          ? t("开启「证券研究与每日对账」自动更新后，开盘时段每 10 分钟更新一次。", "Turn on Research & daily reconciliation updates to refresh sectors every 10 minutes while the market is open.")
          : data?.monitor?.nextRunAt
            ? t("下一次更新 ", "Next update ") + formatDateTime(data.monitor.nextRunAt, locale, timeZone)
            : undefined}
        action={data?.monitor?.enabled === false
          ? <Button component={Link} href="/settings" variant="default">{t("打开设置", "Open settings")}</Button>
          : undefined}
      />
    </section>
  ) : (
    <>
      {/* Stylesheets choose between the map and the phone list, so neither flashes before the width is known. */}
      {!phone && (
        <div className="mx-sectors-body" data-fetching={query.isPlaceholderData ? "" : undefined}>
          <SectorMap groups={groups} kind={kind} selected={selected} onSelect={select}
            label={locale === "zh" ? `${names[market]}板块地图` : `${names[market]} sector map`} />
          {detail && <SectorDetail key={market + kind + detail.key} group={detail} board={board}
            sessions={status?.sessions ?? []} kind={kind}
            openSubgroup={subgroup?.group === detail.key ? subgroup.key : null} />}
        </div>
      )}
      <div className="mx-sectors-phone" data-fetching={query.isPlaceholderData ? "" : undefined}>
        {phoneDetail ? (
          <SectorDetail key={phoneDetail.key} group={phoneDetail} board={board} sessions={status?.sessions ?? []}
            kind={kind} openSubgroup={null} focusOnOpen />
        ) : (
          <SectorList groups={groups} board={board} sessions={status?.sessions ?? []} kind={kind}
            focusKey={returnTo} onFocused={() => setReturnTo(null)} onOpen={(key) => select(key)} />
        )}
      </div>
    </>
  );
  return (
    <Page
      title={t("板块行情", "Sectors")}
      titleHidden
      className="mx-sectors-page"
      actions={
        phoneDetail ? (
          <div className="mx-sectors-bar">
            {back}
            {clock}
          </div>
        ) : (
          <div className="mx-sectors-bar">
            {marketSwitch}
            {clock}
            {groupingSwitch && <div className="mx-sectors-grouping">{groupingSwitch}</div>}
          </div>
        )
      }
    >
      {body}
    </Page>
  );
}

function SessionClock({ status, board, phase, phaseName, monitorOn, refreshFailed, retry, now }: {
  status: SectorMarketStatus;
  board: SectorBoardResponse["board"];
  phase: MarketPhase;
  phaseName: Record<MarketPhase, string>;
  monitorOn: boolean;
  refreshFailed: boolean;
  /** A market switch the server rejected: the board shown stays, with a way to ask again. */
  retry?: { label: string; busy: boolean; run: () => void };
  now: Date;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  // An error at or after the shown board's fetch is current; an earlier one was already overcome.
  const failed = Boolean(status.lastErrorAt && (!board || Date.parse(status.lastErrorAt) >= Date.parse(board.fetchedAt)));
  // After the bell a board can be published before enough official closes arrive: it is not final yet.
  const unsettled = board != null && !board.complete && (phase === "closed" || phase === "pre-open")
    && board.sessionDate === status.sessionDate;
  // Delayed exchanges run 15–20 minutes behind and refresh every ten.
  const lagging = !failed && phase === "open" && board?.asOf != null && now.getTime() - Date.parse(board.asOf) > 45 * 60_000;
  const asOf = board?.asOf ?? null;
  const source = board?.source;
  const published = source ? formatCalendarDate(source.asOf, locale) : "";
  return (
    <div className="mx-sectors-clock" aria-live="polite">
      {phaseName[phase] && <span>{phaseName[phase]}</span>}
      {asOf && <span>{t("截至 ", "As of ") + formatDateTime(asOf, locale, timeZone, now)}</span>}
      {retry ? <button type="button" className="mx-tag mx-tag-warn mx-sectors-retry" aria-disabled={retry.busy || undefined}
        onClick={retry.busy ? undefined : retry.run}>{retry.label}</button>
        : refreshFailed ? <Tag tone="warn">{t("刷新失败", "Refresh failed")}</Tag>
        : unsettled && failed ? <Tag tone="warn">{t("收盘价未齐", "Closing prices incomplete")}</Tag>
        : failed ? <Tag tone="warn">{t("更新失败", "Update failed")}</Tag>
        : !monitorOn && phase === "open" ? <Tag tone="warn">{t("自动更新已关闭", "Updates off")}</Tag>
          : lagging ? <Tag tone="warn">{t("数据滞后", "Delayed")}</Tag> : null}
      {source && (
        <Help label={t("板块数据来源", "Sector data sources")}>
          <p>
            {locale === "zh"
              ? `成分股与权重来自 ${source.fund}（${source.universe}）${published} 公布的持仓；行情来自 ${source.prices}，以截至时间为准。`
              : `Constituents and weights: ${source.fund} (${source.universe}) holdings published ${published}. Prices: ${source.prices}, as of the time shown.`}
          </p>
          <p>
            {t(
              "板块涨跌按成分股权重加权；涨跌 ±0.05% 以内算持平；排名比较近 5 个交易日的板块涨跌，有报价的成分股不到板块权重一半时不排名（主题另需至少 3 只有报价）。你的持仓是穿透后落在这些成分股上的金额，百分比是它占穿透后已投资总额的比例。",
              "Sector moves are weighted by index weight; moves within ±0.05% count as flat; ranks compare sector moves over the last five sessions, and a sector with less than half its weight priced is not ranked (a theme also needs three priced members). Your exposure is the look-through value in these constituents; its percentage is a share of your total look-through invested value.",
            )}
          </p>
        </Help>
      )}
    </div>
  );
}
