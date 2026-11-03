"use client";

import { useLocale } from "@/components/locale-provider";
import type { JobOutcomes } from "@/lib/types";
import { formatDateTime } from "@/ui/formatters";
import { useCopy } from "./foundation";

type Cause = JobOutcomes["causes"] extends Array<infer Item> | undefined ? Item : never;

/** Groups stage error codes into the part of the service a reader can act on. */
export function causeArea(code: string | null | undefined, t: (zh: string, en: string) => string) {
  const area = (code ?? "").split(".")[0];
  if (code === "job.interrupted") return t("任务中断", "Interrupted");
  if (area === "broker") return t("券商同步", "Broker sync");
  if (area === "account") return t("账户计算", "Account calculations");
  if (area === "portfolio") return t("持仓穿透", "Look-through");
  if (area === "research" || area === "market" || area === "reference") return t("研究数据", "Research data");
  if (area === "snapshot" || area === "stage") return t("快照发布", "Snapshot publishing");
  return code || t("未知原因", "Unknown cause");
}

/** Names the cause behind an error code when the backend could identify it. */
export function causeKind(kind: string | null | undefined, t: (zh: string, en: string) => string) {
  if (kind === "network") return t("连接失败", "Connection failed");
  if (kind === "rate_limit") return t("券商限流", "Rate limited");
  if (kind === "reconciliation") return t("持仓与汇总不一致", "Positions differ from summary");
  return null;
}

export function outcomeSummary(outcomes: JobOutcomes) {
  const { succeeded = 0, failed = 0, interrupted = 0 } = outcomes.totals;
  const finished = succeeded + failed + interrupted;
  const failures = failed + interrupted;
  return { finished, failures, rate: finished ? failures / finished : 0 };
}

/** Seven days of finished updates; quiet when everything succeeded. */
export function JobOutcomeSummary({
  outcomes,
  scopeLabel,
}: {
  outcomes: JobOutcomes | null | undefined;
  scopeLabel: (scope: string) => string;
}) {
  const t = useCopy();
  const { locale, timeZone } = useLocale();
  if (!outcomes) return null;
  const { finished, failures, rate } = outcomeSummary(outcomes);
  if (!finished) return null;
  const count = (value: number) => value.toLocaleString(locale === "zh" ? "zh-CN" : "en-GB");
  if (!failures)
    return (
      <p className="mx-job-outcomes mx-muted">
        {locale === "zh" ? `近 7 天 ${count(finished)} 次更新全部成功` : `All ${count(finished)} updates in the last 7 days succeeded`}
      </p>
    );
  return (
    <section className="mx-job-outcomes" aria-label={t("近 7 天失败", "Failures in the last 7 days")}>
      <p>
        {locale === "zh"
          ? `近 7 天 ${count(finished)} 次更新，${count(failures)} 次失败（${(rate * 100).toFixed(1)}%）`
          : `${count(failures)} of ${count(finished)} updates failed in the last 7 days (${(rate * 100).toFixed(1)}%)`}
      </p>
      <ul>
        {(outcomes.causes ?? []).slice(0, 4).map((cause: Cause) => (
          <li
            key={[cause.errorCode, cause.scope, cause.kind].join("|")}
            title={cause.lastMessage ?? cause.errorCode ?? undefined}
          >
            <strong>{causeArea(cause.errorCode, t)}</strong>
            {causeKind(cause.kind, t) && <span>{causeKind(cause.kind, t)}</span>}
            <span>{scopeLabel(cause.scope)}</span>
            <span className="mx-down">{locale === "zh" ? `${count(cause.count)} 次` : `${count(cause.count)}×`}</span>
            {cause.lastAt && (
              <span className="mx-muted">
                {t("最近 ", "Last ") + formatDateTime(cause.lastAt, locale, timeZone)}
              </span>
            )}
            {cause.lastMessage && <small>{cause.lastMessage}</small>}
          </li>
        ))}
      </ul>
    </section>
  );
}

