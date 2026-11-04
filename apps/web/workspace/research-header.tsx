"use client";

import type { ResearchLensSnapshot, ResearchShell } from "@/lib/types";
import { ActionIcon, Avatar, Button, Group, Loader, Menu } from "@mantine/core";
import { ArrowClockwise, DotsThree, Trash } from "@phosphor-icons/react";
import { currency, object, percent, tone } from "@/workspace/data";
import { quoteValue } from "./financial-values";
import { Panel, Tag, useCopy } from "./foundation";

type ResearchInstrument = ResearchShell["instruments"][number];

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
                <Tag tone="good">
                  {t("已持有 ", "Held ") +
                    currency(selected.exposureGbp)}
                </Tag>
              )}
            </div>
          </div>
        </div>
        <div className="mx-security-price">
          <strong>
            {quoteValue(
              quote?.context?.quote.price ??
                market.spot ??
                quote?.technical?.price ??
                quote?.valuation?.spot,
              quote?.context?.quote.currency || market.currency,

              t("币种未提供", "Currency unavailable"),
            )}
          </strong>
          {quote?.context?.quote.changePct != null && (
            <small
              className={
                "mx-security-change mx-" + tone(quote.context.quote.changePct)
              }
            >
              {percent(quote.context.quote.changePct, true, 2)}
              {quote.context.quote.change != null &&
                " (" +
                  quoteValue(
                    quote.context.quote.change,
                    quote.context.quote.currency,
                    "—",
                  ) +
                  ")"}
            </small>
          )}
          {quote?.context?.quote.asOf && (
            <small>
              {/* Regular session is the normal state; only exceptions are named. */}
              {[
                new Intl.DateTimeFormat(t("zh-CN", "en-GB"), {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: quote.context.quote.timezone ?? "UTC",
                }).format(new Date(quote.context.quote.asOf)) +
                  " " +
                  exchangeZone(quote.context.quote.timezone, t),
                (
                  {
                    closed: t("收盘", "Closed"),
                    post: t("盘后", "Post-market"),
                    pre: t("盘前", "Pre-market"),
                  } as Record<string, string>
                )[quote.context.quote.session],
                quote.context.quote.delayMinutes
                  ? t("延迟 ", "Delayed ") + quote.context.quote.delayMinutes + t(" 分钟", " min")
                  : null,
              ].filter(Boolean).join(" · ")}
            </small>
          )}
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

/** Exchange-local time names the market, not an offset. */
function exchangeZone(zone: string | null | undefined, t: (zh: string, en: string) => string) {
  if (!zone) return "UTC";
  if (zone === "America/New_York") return t("美东", "ET");
  if (zone === "Europe/London") return t("伦敦", "London");
  if (zone === "Asia/Hong_Kong") return t("香港", "Hong Kong");
  if (zone === "Asia/Tokyo") return t("东京", "Tokyo");
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}
