"use client";

import type { ResearchLensSnapshot, ResearchShell } from "@/lib/types";
import { ActionIcon, Avatar, Button, Loader, Menu } from "@mantine/core";
import { ArrowClockwise, CaretDown, DotsThree, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { numeric } from "@/lib/numeric";
import { currency, object, percent, tone } from "@/workspace/data";
import { quoteValue } from "./financial-values";
import { Panel, Tag, UpdateFailure, useCopy } from "./foundation";
import { DemoAsOf, useDemonstration } from "./demonstration";
import { priceBasis, type PriceTime } from "./research-price-basis";

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
 * Name, listing and price of the selected security, shown once. The name is the
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
  selected: ResearchInstrument;
  quote: ResearchLensSnapshot | undefined;
  quotePending: boolean;
  failure?: { updatedAt: number; retry: () => unknown };
  /** Whether the research list is open or pinned beside the page. */
  listOpen: boolean;
  onSwitch: () => void;
}) {
  const t = useCopy();
  const market = object(quote?.market);
  const now = useMinuteClock();
  const basis = priceBasis(
    selected,
    quote?.context?.quote,
    numeric(market.spot ?? quote?.technical?.price ?? quote?.valuation?.spot),
    typeof market.currency === "string" ? market.currency : null,
    new Date(now),
  );
  // Older services report only the look-through exposure.
  const heldValue = selected.directValueGbp ?? selected.exposureGbp;
  const name = selected.name || ticker;
  return (
    <Panel className="mx-security-panel">
      <div className="mx-security-header">
        <div className="mx-security-name">
          <Avatar
            key={ticker}
            src={`/api/company-logo/${encodeURIComponent(ticker)}`}
            alt=""
            aria-hidden="true"
            size={48}
            radius="md"
            className="mx-company-logo"
          >
            {ticker.slice(0, 2)}
          </Avatar>
          <div>
            <h2>
              <button
                type="button"
                className="mx-security-switcher"
                aria-label={name + t("，切换证券", ", switch security")}
                aria-expanded={listOpen}
                onClick={onSwitch}
              >
                {name}
                <CaretDown size={16} aria-hidden="true" />
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
              {selected.held && (
                <Tag>{t("已持有 ", "Held ") + currency(heldValue, "GBP", 2)}</Tag>
              )}
            </div>
          </div>
        </div>
        <div className="mx-security-price">
          {basis.price == null && quotePending ? (
            <span aria-hidden="true" className="mx-quote-reserved" />
          ) : basis.price == null ? (
            <small>{t("暂无价格", "Price unavailable")}</small>
          ) : <strong>
            {quoteValue(
              basis.price,
              basis.currency,
              t("币种未提供", "Currency unavailable"),
            )}
          </strong>}
          {basis.changePct != null && (
            <small className={"mx-security-change mx-" + tone(basis.changePct)}>
              {percent(basis.changePct, true, 2)}
              {basis.change != null &&
                " (" + quoteValue(basis.change, basis.currency, "—") + ")"}
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

/** Update and manage the selected security; they close the research tool row. */
export function SecurityActions({
  held,
  categoriesAvailable,
  busy,
  pending,
  onRefresh,
  onManage,
  onRemove,
}: {
  held: boolean;
  categoriesAvailable: boolean;
  busy: boolean;
  pending: boolean;
  onRefresh: () => void;
  onManage: () => void;
  onRemove: () => void;
}) {
  const t = useCopy();
  return (
    <div className="mx-research-actions">
      {/* Phones show the icon alone; the name stays 更新研究 in every state. */}
      <Button
        className="mx-research-refresh"
        aria-label={t("更新研究", "Update research")}
        variant="default"
        leftSection={busy ? <Loader size={14} /> : <ArrowClockwise size={16} />}
        disabled={busy}
        onClick={() => onRefresh()}
      >
        {busy ? t("更新中…", "Updating…") : t("更新研究", "Update research")}
      </Button>
      <Menu shadow="md" position="bottom-end">
        <Menu.Target>
          <ActionIcon aria-label={t("管理当前证券", "Manage this security")}>
            <DotsThree size={23} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item disabled={!categoriesAvailable} onClick={() => onManage()}>
            {categoriesAvailable
              ? t("调整研究分类", "Change research category")
              : t("尚未设置研究分类", "No research categories configured")}
          </Menu.Item>
          <Menu.Item
            color="red"
            disabled={held || pending}
            leftSection={<Trash size={15} />}
            onClick={() => onRemove()}
          >
            {held
              ? t("持仓标的保留在研究中", "Held securities stay in research")
              : t("从研究清单移除", "Remove from research")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
