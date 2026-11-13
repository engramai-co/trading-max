"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import type { SectorBoard, SectorBoardResponse, SectorMarketStatus } from "@/lib/types";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { Help, Tag, useCopy } from "./foundation";
import type { MarketPhase } from "./sectors-data";
import { DemoAsOf, useDemonstration } from "./demonstration";

/** Re-reads the clock each minute so session states turn without a refetch. */
export function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** A session state's name; an unknown calendar has none. */
export function usePhaseNames(): Record<MarketPhase, string> {
  const t = useCopy();
  return {
    open: t("盘中", "Open"),
    break: t("午休", "Lunch break"),
    closed: t("已收盘", "Closed"),
    "pre-open": t("未开盘", "Pre-open"),
    unknown: "",
  };
}

/** Where a board's constituents and prices come from, and how sectors are measured. */
export function SectorSources({ source }: { source: SectorBoard["source"] }) {
  const t = useCopy();
  const { locale } = useLocale();
  const demonstration = useDemonstration();
  if (demonstration) return <p>{t("成分股、权重和涨跌均为演示数据。", "Constituents, weights and price moves are synthetic.")}</p>;
  const published = formatCalendarDate(source.asOf, locale);
  const basket = source.fundTicker === "IJPN" ? "IJPN" : source.fund;
  return (
    <>
      <p>
        {locale === "zh"
          ? `成分股与权重来自 ${basket}（${source.universe}）${published} 公布的持仓；行情来自 ${source.prices}，以截至时间为准。`
          : `Constituents and weights: ${basket} (${source.universe}) holdings published ${published}. Prices: ${source.prices}, as of the time shown.`}
      </p>
      {source.fundTicker === "SMEA" && <p>{t(
        "地图面积和持仓按完整成分篮子计算；涨跌、家数和排名使用欧洲上市股样本，目标覆盖篮子至少 95% 的权重，以各股的交易币种计算。",
        "Map area and exposure use the full basket. Moves, breadth and ranks use the largest European listings, with a target of at least 95% of basket weight, in each listing’s own currency.",
      )}</p>}
      {source.quoteWeightTarget != null && source.fundTicker !== "SMEA" && <p>{locale === "zh"
        ? `面积和穿透敞口使用完整篮子；行情优先覆盖权重最高的成分股，目标为篮子权重的 ${Math.round(source.quoteWeightTarget * 100)}%。`
        : `Area and look-through exposure use the full basket. Quotes prioritise the largest constituents, targeting ${Math.round(source.quoteWeightTarget * 100)}% of basket weight.`}
      </p>}
      <p>
        {t(
          "板块涨跌按成分股权重加权；涨跌 ±0.05% 以内算持平；排名比较近 5 个交易日的板块涨跌，有报价的成分股不到板块权重一半时不排名（主题另需至少 3 只有报价）。你的持仓是穿透后落在这些成分股上的金额，百分比是它占穿透后已投资总额的比例。",
          "Sector moves are weighted by index weight; moves within ±0.05% count as flat; ranks compare sector moves over the last five sessions, and a sector with less than half its weight priced is not ranked (a theme also needs three priced members). Your exposure is the look-through value in these constituents; its percentage is a share of your total look-through invested value.",
        )}
      </p>
    </>
  );
}

/** The session state, the board's time and the one caveat that applies, with the sources one tap away. */
export function SessionClock({ status, board, phase, phaseName, monitorOn, refreshFailed, retry, now, sources = true }: {
  status: SectorMarketStatus;
  board: SectorBoardResponse["board"];
  phase: MarketPhase;
  phaseName: Record<MarketPhase, string>;
  monitorOn: boolean;
  refreshFailed: boolean;
  /** A market switch the server rejected: the board shown stays, with a way to ask again. */
  retry?: { label: string; busy: boolean; run: () => void };
  now: Date;
  /** Off where the sources already sit beside the surface's title. */
  sources?: boolean;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const demonstration = useDemonstration();
  if (demonstration) return board ? <div className="mx-sectors-clock">
    <DemoAsOf date={board.asOf} />
    {sources && <Help label={t("板块数据来源", "Sector data sources")}><SectorSources source={board.source} /></Help>}
  </div> : null;
  // An error at or after the shown board's fetch is current; an earlier one was already overcome.
  const failed = Boolean(status.lastErrorAt && (!board || Date.parse(status.lastErrorAt) >= Date.parse(board.fetchedAt)));
  // After the bell a board can be published before enough official closes arrive: it is not final yet.
  const unsettled = board != null && !board.complete && (phase === "closed" || phase === "pre-open")
    && board.sessionDate === status.sessionDate;
  // Delayed exchanges run 15–20 minutes behind and refresh every ten.
  const lagging = !failed && phase === "open" && board?.asOf != null && now.getTime() - Date.parse(board.asOf) > 45 * 60_000;
  const asOf = board?.asOf ?? null;
  const source = board?.source;
  return (
    <div className="mx-sectors-clock" aria-live="polite">
      {status.calendarKnown === false ? <Tag tone="warn">{t("日历未知", "Calendar unknown")}</Tag>
        : phaseName[phase] && <span>{phaseName[phase]}</span>}
      {asOf && <span>{t("截至 ", "As of ") + formatDateTime(asOf, locale, timeZone, now)}</span>}
      {retry ? <button type="button" className="mx-tag mx-tag-warn mx-sectors-retry" aria-disabled={retry.busy || undefined}
        onClick={retry.busy ? undefined : retry.run}>{retry.label}</button>
        : refreshFailed ? <Tag tone="warn">{t("刷新失败", "Refresh failed")}</Tag>
        : unsettled && failed ? <Tag tone="warn">{t("收盘价未齐", "Closing prices incomplete")}</Tag>
        : failed ? <Tag tone="warn">{t("更新失败", "Update failed")}</Tag>
        : !monitorOn && phase === "open" ? <Tag tone="warn">{t("自动更新已关闭", "Updates off")}</Tag>
          : lagging ? <Tag tone="warn">{t("数据滞后", "Delayed")}</Tag> : null}
      {sources && source && (
        <Help label={t("板块数据来源", "Sector data sources")}>
          <SectorSources source={source} />
        </Help>
      )}
    </div>
  );
}
