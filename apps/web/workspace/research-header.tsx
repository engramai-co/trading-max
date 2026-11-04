"use client";

import type { ResearchLensSnapshot, ResearchShell } from "@/lib/types";
import { ActionIcon, Avatar, Button, Group, Loader, Menu } from "@mantine/core";
import { ArrowClockwise, DotsThree, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate, formatDateTime } from "@/ui/formatters";
import { numeric } from "@/lib/numeric";
import { currency, object, percent, tone } from "@/workspace/data";
import { quoteValue } from "./financial-values";
import { Panel, Tag, useCopy } from "./foundation";
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

/** Name, listing, price and actions for the selected security. */
export function SecurityHeader({
  ticker,
  selected,
  quote,
  categoriesAvailable,
  busy,
  pending,
  onRefresh,
  onManage,
  onRemove,
}: {
  ticker: string;
  selected: ResearchInstrument;
  quote: ResearchLensSnapshot | undefined;
  categoriesAvailable: boolean;
  busy: boolean;
  pending: boolean;
  onRefresh: () => void;
  onManage: () => void;
  onRemove: () => void;
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
            <h2>{selected.name || ticker}</h2>
            <div className="mx-security-meta">
              <strong>{ticker}</strong>
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
          <strong>
            {quoteValue(
              basis.price,
              basis.currency,
              t("币种未提供", "Currency unavailable"),
            )}
          </strong>
          {basis.changePct != null && (
            <small className={"mx-security-change mx-" + tone(basis.changePct)}>
              {percent(basis.changePct, true, 2)}
              {basis.change != null &&
                " (" + quoteValue(basis.change, basis.currency, "—") + ")"}
            </small>
          )}
          {basis.time && <PriceTimeLabel time={basis.time} />}
        </div>
      </div>
      <div className="mx-research-controls">
        <Group gap="xs">
          <Button
            aria-label={t("更新研究", "Update research")}
            variant="default"
            size="xs"
            leftSection={busy ? <Loader size={12} /> : <ArrowClockwise size={14} />}
            disabled={busy}
            onClick={() => onRefresh()}
          >
            <span className="mx-action-long">
              {busy ? t("更新中…", "Updating…") : t("更新研究", "Update research")}
            </span>
            <span className="mx-action-short">
              {busy ? t("更新中", "Updating") : t("更新", "Update")}
            </span>
          </Button>
          <Menu shadow="md">
            <Menu.Target>
              <ActionIcon
                aria-label={t(
                  "管理当前证券",
                  "Manage this security",
                )}
              >
                <DotsThree size={23} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                disabled={!categoriesAvailable}
                onClick={() => onManage()}
              >
                {categoriesAvailable
                  ? t("调整研究分类", "Change research category")
                  : t(
                      "尚未设置研究分类",
                      "No research categories configured",
                    )}
              </Menu.Item>
              <Menu.Item
                color="red"
                disabled={selected.held || pending}
                leftSection={<Trash size={15} />}
                onClick={() => onRemove()}
              >
                {selected.held
                  ? t(
                      "持仓标的保留在研究中",
                      "Held securities stay in research",
                    )
                  : t("从研究清单移除", "Remove from research")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </div>
    </Panel>
  );
}
