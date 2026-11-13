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
import type { SectorBoardResponse, SectorGroupingKind, SectorMarketCode } from "@/lib/types";
import { formatDateTime } from "@/ui/formatters";
import { api } from "@/workspace/data";
import { useDemonstration } from "./demonstration";
import { Empty, Page, Pending, QueryError, Segments, useCopy } from "./foundation";
import { GlobalMarkets } from "./global-markets";
import Link from "./link";
import { IndexDetail, IndexStrip } from "./market-indices";
import { INDEX_MARKETS, INDEX_RANGES, indexHref, indexMarket, type IndexScope } from "./market-indices-data";
import { useRouteState } from "./route-state";
import { SessionClock, useMinute, usePhaseNames } from "./sectors-clock";
import { SectorDetail, SectorList } from "./sectors-detail";
import { SectorMap } from "./sectors-map";
import { SectorMarketSwitch } from "./sectors-market-switch";
import { SECTOR_MARKETS, marketPhase, sectorMarket, strongestGroup } from "./sectors-data";

export function SectorsWorkspace() {
  const t = useCopy();
  const demonstration = useDemonstration();
  const { locale, timeZone } = useLocale();
  useEffect(() => {
    const title = locale === "zh" ? "市场 · Trading Max" : "Markets · Trading Max";
    const setTitle = () => {
      if (/^(?:\/desktop)?\/sectors\/?$/.test(location.pathname) && document.title !== title) {
        document.title = title;
      }
    };
    // The route's server metadata can stream in after the locale is restored.
    const observer = new MutationObserver(setTitle);
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    setTitle();
    return () => observer.disconnect();
  }, [locale]);
  const { params, update } = useRouteState();
  const phone = useMediaQuery("(max-width: 767px)") ?? false;
  const now = useMinute();
  const openedIndex = demonstration ? null : params.get("index");
  const range = INDEX_RANGES.find((item) => item === params.get("range")) ?? "1Y";
  const indexReturn = useRef<{ id: string; scroll: number; left: number } | null>(null);
  const requested = demonstration && params.get("market") !== "global"
    ? sectorMarket(params.get("market")) ?? "us" : indexMarket(params.get("market"));
  const requestedBoard = sectorMarket(requested);
  const indicesOnly = requested !== null && requestedBoard === null;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["workspace-sectors", requestedBoard ?? "default"],
    enabled: !indicesOnly,
    queryFn: async ({ signal }) => {
      const answer = await api<SectorBoardResponse>("/sectors" + (requestedBoard ? "?market=" + requestedBoard : ""), { signal });
      // The default answer also fills its market's own entry when that is still empty, so
      // naming the market in the URL (as selecting a sector does) reuses it rather than
      // starting over; a slower default answer never replaces a newer explicit one.
      const own = ["workspace-sectors", answer.market];
      if (!requestedBoard && client.getQueryData(own) === undefined) client.setQueryData(own, answer);
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
  const wanted: IndexScope = requested ?? data?.market ?? "us";
  // The requested market has answered for itself, with a board or an honest empty one.
  const answered = !query.isPlaceholderData && data?.market === wanted;
  // A switch the server rejects falls back to the board already on screen, under its own
  // market's name, with a retry for the market that failed. The fallback stays while a
  // retry is in flight and gives way only to the requested market's own answer.
  const rejected = !indicesOnly && !answered && (query.isError || query.errorUpdatedAt > 0)
    && lastGood?.board != null && lastGood.market !== wanted;
  const shown = rejected ? lastGood : data;
  const market: IndexScope = rejected && lastGood ? lastGood.market : wanted;
  // While another market loads, the previous answer still supplies sessions for
  // the switch, but its board is never shown under the new market's name.
  const board = !indicesOnly && shown?.board?.market === market ? shown.board : null;
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
  const names: Record<IndexScope, string> = {
    global: t("全球", "Global"),
    eu: t("欧洲", "Europe"),
    tw: t("台股", "Taiwan"),
    in: t("印股", "India"),
    ca: t("加股", "Canada"),
    au: t("澳股", "Australia"),
    ch: t("瑞士", "Switzerland"),
    us: t("美股", "US"),
    uk: t("英股", "UK"),
    hk: t("港股", "Hong Kong"),
    kr: t("韩股", "Korea"),
    jp: t("日股", "Japan"),
  };
  // Short labels for markets with established abbreviations.
  const shortNames: Partial<Record<SectorMarketCode, string>> = {
    us: t("美股", "US"),
    uk: t("英股", "UK"),
    hk: t("港股", "HK"),
    kr: t("韩股", "KR"),
    jp: t("日股", "JP"),
  };
  const phases = Object.fromEntries((shown?.markets ?? []).map((item) => [item.market, marketPhase(item.sessions, item.timezone, now)]));
  const phaseName = usePhaseNames();
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
    <SectorMarketSwitch
      value={market}
      phone={phone}
      onChange={(value) => {
        // Asking again for the market that just failed retries it, once at a time.
        if (value === requested && (query.isError || rejected)) {
          if (!query.isFetching) void query.refetch();
        } else update({ market: value, sector: null, index: null, range: null, currency: null, compare: null });
      }}
      options={(demonstration ? ["global" as const, ...SECTOR_MARKETS] : INDEX_MARKETS).map((value) => {
        const boardMarket = sectorMarket(value);
        const short = boardMarket ? shortNames[boardMarket] : undefined;
        return {
          value,
          label: names[value],
          short: short !== names[value] ? short : undefined,
          marker: phases[value]?.phase === "open" ? phaseName.open : undefined,
        };
      })}
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
  useEffect(() => {
    if (openedIndex) window.scrollTo({ top: 0 });
    else if (indexReturn.current) {
      const { id, scroll, left } = indexReturn.current;
      const frame = requestAnimationFrame(() => {
        const card = document.getElementById(`index-card-${id}`);
        if (!card) return;
        if (card.parentElement) card.parentElement.scrollLeft = left;
        card.focus({ preventScroll: true });
        window.scrollTo({ top: scroll });
        indexReturn.current = null;
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [openedIndex]);
  const updateIndex = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const suffix = next.size ? "?" + next.toString() : "";
    const drill = (window.history.state as { indexDrill?: boolean } | null)?.indexDrill;
    window.history.replaceState(drill ? { indexDrill: true } : null, "", window.location.pathname + suffix);
  };
  const indexBack = (
    <button type="button" className="mx-sector-back" onClick={() => {
      if ((window.history.state as { indexDrill?: boolean } | null)?.indexDrill) window.history.back();
      else update({ index: null, range: null, currency: null, compare: null });
    }}>
      <ArrowLeft size={18} aria-hidden="true" />
      {names[wanted]}
    </button>
  );
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
  const body = indicesOnly ? null : !rejected && (query.isPending || switching) ? (
    <Pending />
  ) : query.isError && !board ? (
    <QueryError retry={query.refetch} />
  ) : !board || !groups.length ? (
    <section className="mx-panel">
      <Empty
        headingLevel={2}
        title={locale === "zh" ? `还没有${names[market]}板块数据` : `No ${names[market]} sector data yet`}
        description={demonstration
          ? t("此市场没有演示板块数据。", "Sector data for this market is not included in the demo.")
          : data?.monitor?.enabled === false
          ? t("开启「证券研究与每日对账」自动更新后，开盘时段每 10 分钟更新一次。", "Turn on Research & daily reconciliation updates to refresh sectors every 10 minutes while the market is open.")
          : data?.monitor?.nextRunAt
            ? t("下一次更新 ", "Next update ") + formatDateTime(data.monitor.nextRunAt, locale, timeZone)
            : undefined}
        action={!demonstration && data?.monitor?.enabled === false
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
      title={t("市场", "Markets")}
      titleHidden
      className={`mx-sectors-page${market === "global" && !openedIndex ? " mx-global-page" : ""}`}
      actions={
        openedIndex && phone ? (
          <div className="mx-sectors-bar">{indexBack}</div>
        ) : phoneDetail ? (
          <div className="mx-sectors-bar">
            {back}
            {clock}
          </div>
        ) : (
          <div className="mx-sectors-bar">
            {marketSwitch}
            {!openedIndex && clock}
            {!openedIndex && groupingSwitch && <div className="mx-sectors-grouping">{groupingSwitch}</div>}
          </div>
        )
      }
    >
      {!demonstration && !phoneDetail && (!openedIndex || !phone) && (
        <IndexStrip market={wanted} marketName={rejected ? names[wanted] : undefined} selected={openedIndex} open={(event, index) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          const href = indexHref(index);
          if (openedIndex === index.id) return;
          if (!openedIndex) {
            indexReturn.current = {
              id: index.id,
              scroll: window.scrollY,
              left: event.currentTarget.parentElement?.scrollLeft ?? 0,
            };
            window.history.pushState({ indexDrill: true }, "", window.location.pathname + href.slice(href.indexOf("?")));
          } else {
            updateIndex({ market: index.scope, index: index.id, range: null, compare: null, currency: null, sector: null });
          }
        }} />
      )}
      {openedIndex ? (
        <>
          {!phone && indexBack}
          <IndexDetail
            id={openedIndex}
            market={wanted}
            period={range}
            gbp={params.get("currency") === "GBP"}
            comparison={params.get("compare")}
            update={updateIndex}
            phone={phone}
          />
        </>
      ) : (
        <>
          {board && !phoneDetail && (market === "jp" || market === "hk" || market === "kr") && (
            <p className="mx-index-note">{t("板块篮子：", "Sector basket: ")}{board.source.universe}</p>
          )}
          {market === "global" ? <GlobalMarkets demo={demonstration} onMarket={(value) =>
            update({ market: value, sector: null, index: null, range: null, currency: null, compare: null })} /> : body}
        </>
      )}
    </Page>
  );
}
