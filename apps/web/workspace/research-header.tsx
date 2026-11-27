"use client";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ResearchLensSnapshot, ResearchShell } from "@/lib/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, Ellipsis, RotateCw, Trash } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { currency, percent, tone } from "@/workspace/data";
import { quoteValue } from "./financial-values";
import { companyLogoSrc, Panel, Tag, UpdateFailure, useCopy } from "./foundation";
import { DemoAsOf, useDemonstration } from "./demonstration";
import Link from "./link";
import { lensFallback, priceBasis, type PriceTime } from "./research-price-basis";

type ResearchInstrument = ResearchShell["instruments"][number];

/** Re-reads the clock every minute so a quote turns late without new data. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** A late price names its session close or time in amber; a timely one stays quiet. */
function PriceTimeLabel({ time }: { time: PriceTime }) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  const demonstration = useDemonstration();
  if (demonstration) return <DemoAsOf date={time.kind === "close" ? time.date : time.asOf} />;
  const when =
    time.kind === "close"
      ? formatCalendarDate(time.date, locale) + t("收盘", " close")
      : formatDateTime(time.asOf, locale, timeZone);
  if (time.stale)
    return (
      <small>
        <Tag tone="warn">{when}</Tag>
      </small>
    );
  return (
    <small>
      {when}
      {time.kind === "time" && time.delayMinutes
        ? " · " + t("延迟 ", "Delayed ") + time.delayMinutes + t(" 分钟", " min")
        : ""}
    </small>
  );
}

/**
 * Name, listing and price of the selected stock or fund, shown once. The name is the
 * switcher: it opens the research list (or focuses the pinned one).
 */
export function SecurityHeader({
  ticker,
  selected,
  quote,
  quotePending,
  failure,
  listOpen,
  onSwitch,
}: {
  ticker: string;
  selected: Pick<ResearchInstrument, "name" | "exchange" | "held" | "directValueGbp" | "exposureGbp"> &
    Partial<Pick<ResearchInstrument, "brokerPrice" | "brokerPriceCurrency" | "brokerAsOf" | "brokerListing" | "usFundPeers">> &
    { fundIsin?: string | null };
  quote: ResearchLensSnapshot | undefined;
  quotePending: boolean;
  failure?: { updatedAt: number; retry: () => unknown };
  /** Whether the research list is open or pinned beside the page. */
  listOpen: boolean;
  onSwitch: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const t = useCopy();
  const now = useMinuteClock();
  const basis = priceBasis(
    selected,
    quote?.context?.quote,
    lensFallback(quote),
    new Date(now),
  );
  // Older services report only the look-through exposure.
  const heldValue = selected.directValueGbp ?? selected.exposureGbp;
  const name = selected.name || ticker;
  const usPeer = selected.usFundPeers?.[0];
  return (
    <Panel className="mx-security-panel">
      <div className="mx-security-header">
        <div className="mx-security-name">
          <Avatar
            key={ticker + (selected.fundIsin ?? "")}
            aria-hidden="true"
            className="mx-company-logo size-12 rounded-[var(--radius-tooltip)] after:hidden"
          >
            <AvatarImage src={companyLogoSrc(ticker, selected.fundIsin)} alt="" className="rounded-none object-contain" />
            <AvatarFallback className="rounded-[inherit] font-semibold">{ticker.slice(0, 2)}</AvatarFallback>
          </Avatar>
          <div>
            <h2>
              <button
                type="button"
                className="mx-security-switcher"
                aria-label={name + t("，打开研究清单", ", open research list")}
                aria-expanded={listOpen}
                onClick={onSwitch}
              >
                {name}
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            </h2>
            <div className="mx-security-meta">
              {selected.name && <strong>{ticker}</strong>}
              <span>
                {quote?.context?.quote.exchange ||
                  (
                    {
                      NMS: "NASDAQ",
                      NGM: "NASDAQ",
                      NCM: "NASDAQ",
                      NYQ: "NYSE",
                      LSE: "London Stock Exchange",
                    } as Record<string, string>
                  )[selected.exchange] ||
                  selected.exchange}
              </span>
              {usPeer && (
                <Link className="mx-text-link" href={`/research?ticker=${encodeURIComponent(usPeer.fund.ticker)}`}>
                  {t("美国同类", "US peer")} · {usPeer.fund.ticker}
                </Link>
              )}
              {selected.held && (
                <Tag>{t("已持有 ", "Held ") + currency(heldValue, "GBP", 2)}</Tag>
              )}
            </div>
          </div>
        </div>
        <div className="mx-security-price">
          {basis.price == null && quotePending ? (
            <Skeleton as="span" className="mx-quote-reserved" />
          ) : basis.price == null ? (
            <small>{t("暂无价格", "Price unavailable")}</small>
          ) : <strong>
            {quoteValue(
              basis.price,
              basis.currency,
              { unknownLabel: t("币种未提供", "Currency unavailable") },
            )}
          </strong>}
          {basis.changePct != null && (
            <small className={"mx-security-change mx-" + tone(basis.changePct)}>
              {percent(basis.changePct, true, 2)}
              {basis.change != null &&
                " (" + quoteValue(basis.change, basis.currency) + ")"}
            </small>
          )}
          <div className="mx-quote-as-of">
            {basis.time && <PriceTimeLabel time={basis.time} />}
            {failure && <UpdateFailure {...failure} />}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Update and manage the selected stock or fund; they close the research tool row. */
export function SecurityActions({
  held,
  categoriesAvailable,
  watchlisted,
  busy,
  pending,
  onRefresh,
  onAdd,
  addDisabled,
  onManage,
  onRemove,
}: {
  held: boolean;
  categoriesAvailable: boolean;
  watchlisted: boolean;
  busy: boolean;
  pending: boolean;
  onRefresh: () => void;
  onAdd?: () => void;
  addDisabled?: boolean;
  onManage: () => void;
  onRemove: () => void;
}) {
  const t = useCopy();
  return (
    <div className="mx-research-actions">
      {/* Phones show the icon alone; the name stays 更新研究 in every state. */}
      {onAdd ? <Button loading={busy} loadingLabel={t("加入中…", "Adding…")} disabled={addDisabled} onClick={onAdd}>{t("加入研究清单", "Add to research list")}</Button> : <Button
        className="mx-research-refresh [@media(max-width:767px)]:w-[var(--mx-tool)] [@media(max-width:767px)]:min-w-[var(--mx-tool)] [@media(max-width:767px)]:px-0"
        aria-label={t("更新研究", "Update research")}
        variant="secondary"
        loading={busy}
        loadingLabel={<span className="mx-research-refresh-label">{t("更新中…", "Updating…")}</span>}
        onClick={() => onRefresh()}
      >
        <RotateCw size={16} aria-hidden="true" />
        <span className="mx-research-refresh-label">{t("更新研究", "Update research")}</span>
      </Button>}
      {watchlisted && <DropdownMenu modal={false}>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t("更多操作", "More actions")}>
            <Ellipsis size={20} aria-hidden="true" />
          </Button>} />
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!categoriesAvailable} onClick={() => onManage()}>
            {categoriesAvailable
              ? t("调整研究分类", "Change research category")
              : t("尚未设置研究分类", "No research categories configured")}
          </DropdownMenuItem>
          {/* Holdings always stay in the list; the item says why it is unavailable. */}
          <DropdownMenuItem
            disabled={held || pending}
            onClick={onRemove}
          >
            <Trash size={16} aria-hidden="true" />
            {t("从研究清单移除", "Remove from research list")}
            {held && <span className="mx-menu-note ml-auto">{t("持仓中", "Held")}</span>}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
  );
}
