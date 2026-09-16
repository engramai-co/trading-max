"use client";

import {
  Button,
  FileInput,
  Group,
  Select,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { UploadSimple, CheckCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { isValidTimeZone, useLocale } from "@/components/locale-provider";
import type {
  AutomationSettings,
  CfdImportStatus,
  UserProfile,
} from "@/lib/types";
import { api, jsonRequest, number } from "./data";
import {
  Empty,
  Facts,
  Freshness,
  Metric,
  Notice,
  Panel,
  Pending,
  QueryError,
  Tag,
  useCopy,
} from "./foundation";

export function AutomationPreferences() {
  const t = useCopy();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["workspace-automation"],
    queryFn: () => api<AutomationSettings>("/settings/automation"),
    retry: 1,
  });
  const mutation = useMutation({
    mutationFn: (change: Record<string, boolean>) =>
      api<AutomationSettings>(
        "/settings/automation",
        jsonRequest("PUT", {
          ...change,
          expectedRevision: query.data?.revision,
        }),
      ),
    onSuccess: (settings) =>
      client.setQueryData(["workspace-automation"], settings),
  });
  const s = query.data;
  const rows = s
    ? [
        {
          key: "liveEnabled",
          enabled: s.liveEnabled,
          title: t("账户状态与日内走势", "Account state & intraday history"),
          description: t(
            "在活动时段刷新余额、持仓并保存日内观测点。",
            "Refresh balances and positions, and record intraday observations during the active window.",
          ),
          schedule:
            (s.liveWindowStart === "00:00" && s.liveWindowEnd === "00:00"
              ? t("全天", "All day")
              : s.liveWindowStart + "–" + s.liveWindowEnd) +
            " · " +
            s.liveTimezone +
            " · " +
            number(s.liveIntervalSeconds / 60) +
            t(" 分钟", " min"),
        },
        {
          key: "performanceEnabled",
          enabled: s.performanceEnabled,
          title: t("收益与风险计算", "Performance calculations"),
          description: t(
            "基于正式账户历史更新收益、回撤和风险指标。",
            "Update returns, drawdowns, and risk metrics from official account history.",
          ),
          schedule:
            number(s.performanceIntervalSeconds / 60) +
            t(" 分钟", " min") +
            " · " +
            s.performanceTimezone,
        },
        {
          key: "researchEnabled",
          enabled: s.researchEnabled,
          title: t("证券研究与每日对账", "Research & daily reconciliation"),
          description:
            t(
              "更新关注列表的市场数据和模型；每日账户流水对账安排在 ",
              "Update watchlist market data and models. Daily account reconciliation runs at ",
            ) +
            s.dailyReconciliationLocalTime +
            " · " +
            s.researchTimezone,
          schedule:
            s.researchLocalTimes.join(" / ") + " · " + s.researchTimezone,
        },
      ]
    : [];
  return (
    <Panel
      title={t("自动更新", "Automatic updates")}
      help={t("运行服务的设备需要保持开机，且任务服务正在运行。", "The device hosting the service must remain on with its task worker running.")}
    >
      {query.isPending ? (
        <Pending />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        <>
          {mutation.isError && (
            <Notice tone="bad">
              {t(
                "未能保存更新计划。请重新加载后重试。",
                "Could not save the schedule. Reload and retry.",
              )}
            </Notice>
          )}
          {rows.map((row) => (
            <div className="mx-setting-row" key={row.key}>
              <div>
                <h3>{row.title}</h3>
                <p>{row.description}</p>
                <span className="mx-form-help">{row.schedule}</span>
              </div>
              <Switch
                aria-label={row.title}
                checked={
                  mutation.isPending &&
                  mutation.variables &&
                  row.key in mutation.variables
                    ? mutation.variables[row.key]
                    : row.enabled
                }
                disabled={mutation.isPending}
                onChange={(event) =>
                  mutation.mutate({ [row.key]: event.currentTarget.checked })
                }
              />
            </div>
          ))}
          <div className="mx-form-help" role="status">
            {mutation.isPending ? t("正在保存…", "Saving…") : mutation.isSuccess ? t("更新计划已保存", "Schedule saved") : null}
          </div>
        </>
      )}
    </Panel>
  );
}

export function CfdImports() {
  const t = useCopy();
  const query = useQuery({
    queryKey: ["workspace-cfd-imports"],
    queryFn: () => api<CfdImportStatus>("/imports/trading212/cfd"),
    retry: 1,
  });
  const [file, setFile] = useState<File | null>(null);
  const [imported, setImported] = useState<"imported" | "duplicate" | null>(
    null,
  );
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("No file");
      return api<{ status: "imported" | "duplicate" }>(
        "/imports/trading212/cfd",
        {
          method: "POST",
          headers: {
            "Content-Type": "text/csv",
            "X-Trading-Max-Filename": encodeURIComponent(file.name),
          },
          body: file,
        },
      );
    },
    onSuccess: (result) => {
      setImported(result.status);
      setFile(null);
      void query.refetch();
    },
  });
  const preference = useMutation({
    mutationFn: (accountStatus: string) =>
      api("/settings/cfd", jsonRequest("PUT", { accountStatus })),
    onSuccess: () => void query.refetch(),
  });
  const data = query.data;
  return (
    <Panel
      title={t("CFD 历史账本", "CFD history ledger")}
    >
      {query.isPending ? (
        <Pending compact />
      ) : query.isError ? (
        <QueryError retry={query.refetch} />
      ) : (
        data && (
          <Stack gap="lg">
            <div className="mx-toolbar">
              <Tag tone={data.isStale ? "warn" : "neutral"}>
                {data.accountStatus === "retired"
                  ? t("已停用账户", "Retired account")
                  : data.isStale
                    ? t("记录需要更新", "History needs updating")
                    : t("活动账户", "Active account")}
              </Tag>
              <Select
                aria-label={t("CFD 账户状态", "CFD account status")}
                value={data.accountStatus}
                data={[
                  { value: "active", label: t("仍在使用", "Still active") },
                  { value: "retired", label: t("已停止使用", "Retired") },
                ]}
                disabled={preference.isPending}
                onChange={(v) => v && preference.mutate(v)}
              />
            </div>
            <div className="mx-metric-grid mx-metric-grid-three">
              <Metric
                label={t("已导入文件", "Imported files")}
                value={number(data.importedFiles, 0)}
              />
              <Metric
                label={t("独立事件", "Unique events")}
                value={number(data.uniqueEvents, 0)}
              />
              <Metric
                label={t("已去重事件", "Duplicates removed")}
                value={number(data.duplicateEvents, 0)}
              />
            </div>
            {(data.isStale || data.warnings.length > 0) && (
              <Notice tone="warn">
                {data.isStale
                  ? t(
                      "最近的活动记录已超过更新期限，可导入新的券商导出文件。",
                      "Recent activity is older than the update threshold. Import a new broker export.",
                    )
                  : data.warnings.join(" · ")}
              </Notice>
            )}
            <div className="mx-import-drop">
              <UploadSimple size={26} />
              <div>
                <h3>{t("导入活动记录", "Import account activity")}</h3>
                <p>
                  {t(
                    "支持 Trading 212 活动 CSV，重复记录自动跳过。",
                    "Trading 212 activity CSV; duplicate records are skipped.",
                  )}
                </p>
              </div>
              <FileInput
                label={t("CFD 活动 CSV 文件", "CFD activity CSV file")}
                placeholder={t("选择 CSV 文件", "Choose CSV file")}
                accept=".csv,text/csv"
                value={file}
                clearable
                clearButtonProps={{ "aria-label": t("清除文件", "Clear file") }}
                onChange={(value) => {
                  setFile(value);
                  setImported(null);
                  upload.reset();
                }}
                disabled={upload.isPending}
              />
              <Button
                leftSection={<UploadSimple size={16} />}
                disabled={!file}
                loading={upload.isPending}
                onClick={() => upload.mutate()}
              >
                {t("导入账本", "Import ledger")}
              </Button>
            </div>
            {upload.isError && (
              <Notice tone="bad">
                {t(
                  "导入未完成。请确认文件为 Trading 212 CFD 活动导出 CSV 后重试。",
                  "Import failed. Check that the file is a Trading 212 CFD activity CSV and retry.",
                )}
              </Notice>
            )}
            {imported && (
              <Notice tone="good">
                {imported === "duplicate"
                  ? t(
                      "这个文件已导入，无需重复添加。",
                      "This file was already imported; no duplicate was added.",
                    )
                  : t(
                      "文件已导入。可前往数据状态更新 CFD 复盘快照。",
                      "File imported. Update the CFD review snapshot from Data status.",
                    )}
              </Notice>
            )}
            {preference.isError && (
              <Notice tone="bad">
                {t(
                  "账户状态未能保存，请重试。",
                  "Account status could not be saved. Retry.",
                )}
              </Notice>
            )}
            <details className="mx-details">
              <summary>
                {t("查看导入记录与覆盖范围", "Import history & coverage")}
              </summary>
              <Facts
                rows={[
                  [
                    t("历史覆盖", "History coverage"),
                    (data.coverageStartDate?.slice(0, 10) ?? "—") +
                      " → " +
                      (data.coverageEndDate?.slice(0, 10) ?? "—"),
                  ],
                  [
                    t("原始记录数", "Raw records"),
                    number(data.totalRawRows, 0),
                  ],
                ]}
              />
              {data.files.length ? (
                <div
                  className="mx-table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label={t("数据表格", "Data table")}
                >
                  <table className="mx-table">
                    <thead>
                      <tr>
                        <th>{t("文件", "File")}</th>
                        <th>{t("导入时间", "Imported")}</th>
                        <th className="mx-align-right">
                          {t("记录", "Records")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.files.map((f) => (
                        <tr key={f.sha256}>
                          <td>{displayFilename(f.filename)}</td>
                          <td>
                            <Freshness date={f.importedAt} label="" />
                          </td>
                          <td className="mx-align-right">
                            {number(f.rawRows, 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title={t("尚未导入任何文件", "No imports yet")} />
              )}
            </details>
          </Stack>
        )
      )}
    </Panel>
  );
}

function displayFilename(filename: string) {
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

export function PersonalPreferences({
  profile,
  refresh,
}: {
  profile: UserProfile;
  refresh: () => void;
}) {
  const t = useCopy();
  const client = useQueryClient();
  const {
    locale,
    setLocale,
    timeZonePreference,
    setTimeZonePreference,
    browserTimeZone,
  } = useLocale();
  const [name, setName] = useState(profile.displayName);
  const [zone, setZone] = useState(timeZonePreference);
  const [labels, setLabels] = useState(profile.accountLabels);
  const draft = {
    displayName: name.trim(),
    accountLabels: { ...labels },
    locale,
    timezone: zone === "browser" ? browserTimeZone : zone,
  };
  const mutation = useMutation({
    mutationFn: (submitted: { values: typeof draft; timeZonePreference: string }) =>
      api("/profile", jsonRequest("PATCH", submitted.values)),
    onSuccess: (_result, submitted) => {
      setTimeZonePreference(submitted.timeZonePreference);
      void client.invalidateQueries({ queryKey: ["workspace-profile"] });
      refresh();
    },
  });
  const saved = mutation.isSuccess &&
    mutation.variables.timeZonePreference === zone &&
    JSON.stringify(mutation.variables.values) === JSON.stringify(draft);
  return (
    <Panel title={t("让工作台更适合你", "A workspace that feels like yours")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending) mutation.mutate({ values: draft, timeZonePreference: zone });
        }}
      >
        <Stack gap="lg">
          <div className="mx-form-grid">
            <TextInput
              label={t("显示名称", "Display name")}
              value={name}
              maxLength={80}
              required
              onChange={(e) => {
                setName(e.currentTarget.value);
              }}
            />
            <Select
              label={t("界面语言", "Interface language")}
              value={locale}
              onChange={(v) => {
                setLocale(v === "en" ? "en" : "zh");
              }}
              data={[
                { value: "zh", label: t("简体中文", "Chinese (Simplified)") },
                { value: "en", label: "English" },
              ]}
            />
            <Select
              label={t("时间显示", "Display timezone")}
              value={zone}
              onChange={(v) => {
                setZone(v ?? "Europe/London");
              }}
              searchable
              data={Array.from(
                new Set([
                  "browser",
                  "Europe/London",
                  "Asia/Shanghai",
                  "America/New_York",
                  "UTC",
                  timeZonePreference,
                ]),
              ).map((value) => ({
                value,
                label:
                  value === "browser"
                    ? t("跟随设备", "Use device timezone") +
                      " · " +
                      browserTimeZone
                    : value,
              }))}
            />
            <TextInput
              label={t("组合记账货币", "Portfolio reporting currency")}
              value={profile.baseCurrency}
              readOnly
              description={t(
                "由账户快照决定",
                "Determined by account snapshots",
              )}
            />
          </div>
          <div>
            <h3 className="mx-section-label">
              {t("账户显示名称", "Account display names")}
            </h3>
            <div className="mx-form-grid">
              {[
                { code: "A", label: "Invest" },
                { code: "B", label: "ISA" },
                { code: "C", label: "CFD" },
              ].map((account) => (
                <TextInput
                  key={account.code}
                  label={account.label}
                  maxLength={60}
                  value={labels[account.code] ?? ""}
                  placeholder={account.label}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setLabels((current) => ({
                      ...current,
                      [account.code]: value,
                    }));
                  }}
                />
              ))}
            </div>
          </div>
          {saved && (
            <Notice tone="good">
              {t("个人偏好已保存。", "Preferences saved.")}
            </Notice>
          )}
          {mutation.isError && (
            <Notice tone="bad">
              {t(
                "未能保存偏好，请重试。",
                "Could not save preferences. Please retry.",
              )}
            </Notice>
          )}
          <Group>
            <Button
              type="submit"
              disabled={
                !name.trim() || (zone !== "browser" && !isValidTimeZone(zone))
              }
              loading={mutation.isPending}
              leftSection={<CheckCircle size={16} />}
            >
              {t("保存偏好", "Save preferences")}
            </Button>
            {mutation.isSuccess && !saved && (
              <span role="status">{t("还有未保存的修改", "You have unsaved changes")}</span>
            )}
          </Group>
        </Stack>
      </form>
    </Panel>
  );
}
