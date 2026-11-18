"use client";
import { useMemo, type ReactNode } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatCalendarDate } from "@/ui/formatters";
import { Plot } from "../charts";
import { Instrument, Panel, useCopy } from "../foundation";
import type { Horizon } from "../review-decisions";
import { signedMoney } from "../review-decisions";
import type { fallObservations } from "../review-patterns";
import Link from "../link";
import { accountName, useWorkspaceProfile } from "../profile";

export function FallTimeline({
  moves,
  horizon,
  action,
}: {
  moves: ReturnType<typeof fallObservations>;
  horizon: Horizon;
  action: ReactNode;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const { data: profile } = useWorkspaceProfile();
  const points = useMemo(
    () =>
      moves
        .flatMap((move) => {
          const value = horizon === "date" ? move.hypotheticalToDateGbp : move.hypotheticalHorizonGbp;
          return value == null ? [] : [{ ...move, value, stamp: Date.parse(move.date) }];
        })
        .sort((a, b) => a.stamp - b.stamp),
    [moves, horizon],
  );
  const readout = useMemo(
    () => ({
      positions: [...new Set(points.map((row) => row.stamp))],
      latest: t("最近", "Latest"),
      read: (stamp: number) => ({
        time: formatCalendarDate(new Date(stamp).toISOString().slice(0, 10), locale),
        groups: [
          points
            .filter((row) => row.stamp === stamp)
            .map((row) => ({
              label: row.ticker + " · " + accountName(profile, row.account),
              value: signedMoney(row.value),
            })),
        ],
      }),
    }),
    [points, locale, profile, t],
  );
  function ranking(adverse: boolean) {
    const ranked = points
      .filter((point) => (adverse ? point.value > 0 : point.value < 0))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 4);
    return (
      <Panel
        title={
          adverse
            ? t("事后错过的收益", "Missed gains in hindsight")
            : t("事后避开的亏损", "Losses avoided in hindsight")
        }
      >
        {ranked.length ? (
          ranked.map((point) => (
            <Link
              key={[point.account, point.date, point.ticker].join("/")}
              className="mx-row-link"
              href={"/research?" + new URLSearchParams({ ticker: point.ticker, view: "technical" })}
            >
              <Instrument
                small
                ticker={point.ticker}
                name={formatCalendarDate(point.date, locale) + " · " + accountName(profile, point.account)}
              />
              <span className="mx-row-value">{signedMoney(Math.abs(point.value)).replace(/^\+/, "")}</span>
            </Link>
          ))
        ) : (
          <p className="mx-review-empty">{t("此区间暂无匹配记录", "No matching record in this window")}</p>
        )}
      </Panel>
    );
  }
  return (
    <>
      <Panel
        title={
          horizon === "date"
            ? t("假设加仓至今的结果", "Hypothetical purchases to date")
            : t("假设加仓 20 个交易日后的结果", "Hypothetical purchases after 20 trading days")
        }
        action={action}
        helpLabel={t("假设加仓", "Hypothetical purchases")}
        help={t(
          "以当日收盘价加仓，金额取该账户截至当天买入这只证券的平均下单额。收益以英镑计，包含随后除息的股息。",
          "Each hypothetical purchase uses the closing price and that account’s mean purchase size for the security through that date. Returns are in GBP and include subsequent dividends.",
        )}
      >
        {!!points.length && (
          <Plot
            research
            height={340}
            label={t("假设加仓的时间线", "Timeline of hypothetical purchases")}
            readout={readout}
            option={(colours) => ({
              grid: { left: 72, right: 20, top: 16, bottom: 32 },
              xAxis: {
                type: "time",
                axisLabel: {
                  formatter: (v: number) =>
                    formatCalendarDate(new Date(v).toISOString().slice(0, 10), locale),
                },
              },
              yAxis: { type: "value", axisLabel: { formatter: (v: number) => signedMoney(v) } },
              series: [
                {
                  type: "scatter",
                  symbol: "emptyCircle",
                  symbolSize: 12,
                  data: points.map((row) => ({
                    value: [row.stamp, row.value],
                    itemStyle: { color: row.value >= 0 ? colours.positive : colours.negative },
                  })),
                },
              ],
            })}
          />
        )}
        {(!points.length || points.length < moves.length) && (
          <p className="mx-muted">
            {t(
              "部分或全部观察尚无可核实的区间结果。",
              "Some or all observations lack a verified outcome for this window.",
            )}
          </p>
        )}
      </Panel>
      <div className="mx-grid mx-review-extremes">
        {ranking(false)}
        {ranking(true)}
      </div>
    </>
  );
}
