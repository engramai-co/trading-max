"use client";

import { FilePicker } from "@/components/ui/file-picker";
import { TextField, useRequiredFields } from "@/components/ui/form-field";

import { useBuildNavigationGuard } from "@/ui/publication-provider";
import { Switch } from "@/components/ui/switch";
import { CircleCheck, Upload } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "./link";
import { isValidTimeZone, useLocale } from "@/components/locale-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import type {
  AutomationSettings,
  CfdImportStatus,
  IntegrationOverview,
  UserProfile,
} from "@/lib/types";
import { api, ApiError, jsonRequest, number } from "@/workspace/data";
import { evidenceNoticesQuery } from "./evidence-notices";
import { accountName, workspaceProfileKey } from "./profile";
import {
  isAcceptedPreferencesSave,
  reconcilePreferencesDraft,
  sameStringRecord,
  type PreferencesDraft,
  type PreferencesSubmission,
} from "./settings-drafts";
import { settingsKey } from "./settings-query";
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
import { SearchPicker, SelectPicker } from "./picker";

export function AutomationPreferences() {
  const t = useCopy();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["workspace-automation"],
    queryFn: () => api<AutomationSettings>("/settings/automation"),
    retry: 1,
  });
  const save = (change: Record<string, boolean>) =>
    api<AutomationSettings>(
      "/settings/automation",
      jsonRequest("PUT", {
        ...change,
        expectedRevision: query.data?.revision,
      }),
    );
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: (settings) =>
      client.setQueryData(["workspace-automation"], settings),
  });
  // Notices of new evidence are local: they compare saved models with new data and never call a model.
  const notices = useMutation({
    mutationFn: (enabled: boolean) => save({ evidenceNoticesEnabled: enabled }),
    onSuccess: (settings) => {
      client.setQueryData(["workspace-automation"], settings);
      void client.invalidateQueries({ queryKey: evidenceNoticesQuery.queryKey });
    },
  });
  const s = query.data;
  const rows = s
    ? [
        {
          key: "liveEnabled",
          enabled: s.liveEnabled,
          title: t("账户状态与日内走势", "Account state & intraday history"),
        },
        {
          key: "performanceEnabled",
          enabled: s.performanceEnabled,
          title: t("收益与风险计算", "Performance calculations"),
        },
        {
          key: "researchEnabled",
          enabled: s.researchEnabled,
          title: t("研究与每日对账", "Research & daily reconciliation"),
        },
      ]
    : [];
  return (
    <>
    <Panel
      title={t("自动更新", "Automatic updates")}
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
                // Both panels save revisions of the same settings, one at a time.
                saving={mutation.isPending && row.key in (mutation.variables ?? {})}
                disabled={mutation.isPending || notices.isPending}
                onCheckedChange={(checked) =>
                  mutation.mutate({ [row.key]: checked })
                }
              />
            </div>
          ))}
          <Link className="mx-text-link" href="/health">{t("查看运行时间与更新记录", "See the schedule and update history")}</Link>
          <div className="mx-form-help" role="status">
            {mutation.isPending ? t("正在保存…", "Saving…") : mutation.isSuccess ? t("更新计划已保存", "Schedule saved") : null}
          </div>
        </>
      )}
    </Panel>
    {s && (
      <Panel
        title={t("提醒", "Notices")}
        help={<>
          <p>{t(
            "已存估值模型之后出现新报表、所用那一期被重述，或一致预期比保存时变动一档（EPS 5%，营收增长 2 个百分点）时，研究清单和「看新证据」旁会出现一个点。同一证据只提示一次。",
            "A dot appears in the research list and beside See new evidence when a saved valuation model has new statements, a restatement of its period, or a consensus move of a full step since it was saved (5% for EPS, two percentage points for revenue growth). Each piece of evidence is announced once.",
          )}</p>
          <p>{t("只在本机比较：不调用模型，不起草，也不保存模型。",
            "Compared on this machine: no model is contacted, and nothing is drafted or saved.")}</p>
        </>}
        helpBasis={t(
          "报表和一致预期来自研究数据，EPS 一致预期的变化来自本地预期记录。公司指引没有单独的数据源，它体现在新报表和一致预期的变化里。",
          "Statements and consensus come from the research data; EPS consensus changes come from the local estimate record. Company guidance has no separate source: it shows through new statements and consensus revisions.",
        )}
      >
        {notices.isError && (
          <Notice tone="bad">
            {t("未能保存提醒设置。请重新加载后重试。", "Could not save the notice setting. Reload and retry.")}
          </Notice>
        )}
        <div className="mx-setting-row">
          <div>
            <h3>{t("已存估值模型的新证据", "New evidence for saved valuation models")}</h3>
          </div>
          <Switch
            aria-label={t("已存估值模型的新证据", "New evidence for saved valuation models")}
            checked={notices.isPending ? notices.variables : s.evidenceNoticesEnabled}
            saving={notices.isPending}
            disabled={notices.isPending || mutation.isPending}
            onCheckedChange={(checked) => notices.mutate(checked)}
          />
        </div>
        <div className="mx-form-help" role="status">
          {notices.isPending ? t("正在保存…", "Saving…") : notices.isSuccess ? t("提醒设置已保存", "Notice setting saved") : null}
        </div>
      </Panel>
    )}
    </>
  );
}

export function CfdImports({ desktop = false, readOnly = false }: { desktop?: boolean; readOnly?: boolean }) {
  const t = useCopy();
  const query = useQuery({
    queryKey: ["workspace-cfd-imports"],
    queryFn: () => api<CfdImportStatus>("/imports/trading212/cfd"),
    retry: 1,
  });
  const [file, setFile] = useState<File | null>(null);
  useBuildNavigationGuard(Boolean(file));
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
  // A retired account's ledger is history: its counts stay with the import records.
  const retired = data?.accountStatus === "retired";
  const counts: Array<[string, string]> = data
    ? [
        [t("已导入文件", "Imported files"), number(data.importedFiles, 0)],
        [t("独立事件", "Unique events"), number(data.uniqueEvents, 0)],
        [t("已去重事件", "Duplicates removed"), number(data.duplicateEvents, 0)],
      ]
    : [];
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
          <div className="flex flex-col gap-mx-lg">
            <div className="mx-toolbar">
              {data.isStale && !retired && <Tag tone="warn">{t("记录需要更新", "History needs updating")}</Tag>}
              <SelectPicker
                style={{ width: 180 }}
                aria-label={t("CFD 账户状态", "CFD account status")}
                value={data.accountStatus}
                options={[
                  { value: "active", label: t("仍在使用", "Still active") },
                  { value: "retired", label: t("已停止使用", "Retired") },
                ]}
                disabled={preference.isPending || readOnly}
                onChange={(v) => v && preference.mutate(v)}
              />
            </div>
            {!retired && (
              <div className="mx-metric-grid mx-metric-grid-three">
                {counts.map(([label, value]) => (
                  <Metric key={label} label={label} value={value} />
                ))}
              </div>
            )}
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
            {desktop && <ol className="mx-import-steps" aria-label={t("导入步骤", "Import steps")}>
              <li data-current={!file && !imported}>{t("1 · 选择 CSV", "1 · Choose CSV")}</li>
              <li data-current={Boolean(file)}>{t("2 · 确认导入", "2 · Import")}</li>
              <li data-current={Boolean(imported)}>{t("3 · 更新复盘", "3 · Update review")}</li>
            </ol>}
            <div className="mx-import-drop">
              <Upload size={20} className="m-[3px]" aria-hidden="true" />
              <FilePicker
                placeholder={t("选择 CFD 活动 CSV 文件", "Choose CFD activity CSV file")}
                accept=".csv,text/csv"
                chosenLabel={t("CFD 活动 CSV 文件：", "CFD activity CSV file: ")}
                value={file}
                clearLabel={t("清除文件", "Clear file")}
                onChange={(value) => {
                  setFile(value);
                  setImported(null);
                  upload.reset();
                }}
                disabled={upload.isPending || readOnly}
              />
              <Button
                disabled={!file || readOnly}
                loading={upload.isPending}
                loadingLabel={t("导入中…", "Importing…")}
                onClick={() => upload.mutate()}
              >
                <Upload size={16} aria-hidden="true" />
                {t("导入账本", "Import ledger")}
              </Button>
              {desktop && file && <p className="mx-form-help">{file.name} · {number(file.size / 1024, 1)} KB · {t("确认后写入当前工作区，重复文件会跳过。", "Import into this workspace; duplicate files will be skipped.")}</p>}
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
            {desktop && imported && <div className="flex flex-wrap items-center gap-mx-md"><Link href="/health?scope=cfd" data-slot="button" className={buttonVariants()}>{t("更新 CFD 复盘", "Update CFD review")}</Link><Link href="/review?account=C" data-slot="button" className={buttonVariants({ variant: "ghost" })}>{t("查看复盘", "View review")}</Link></div>}
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
                  ...(retired ? counts : []),
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
          </div>
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
  const [draft, setDraft] = useState<PreferencesDraft>();
  const [accepted, setAccepted] = useState<UserProfile>();
  const committed = accepted && accepted.revision > profile.revision ? accepted : profile;
  const committedZone = timeZonePreference === "browser" && committed.timezone === browserTimeZone
    ? "browser"
    : committed.timezone ?? timeZonePreference;
  const mutation = useMutation({
    mutationFn: async (submitted: PreferencesSubmission) => {
      const updated = await api<UserProfile>("/profile", jsonRequest("PATCH", submitted.values));
      if (!isAcceptedPreferencesSave(updated, submitted)) {
        throw new ApiError("Unexpected profile revision or values", 409);
      }
      return updated;
    },
    onSuccess: (nextProfile, submitted) => {
      setAccepted(nextProfile);
      if (submitted.timeZonePreference !== undefined) {
        setTimeZonePreference(submitted.timeZonePreference);
      }
      setDraft((current) => current && reconcilePreferencesDraft(current, submitted, nextProfile));
      client.setQueryData<IntegrationOverview>(settingsKey, (overview) =>
        overview && overview.profile.revision <= nextProfile.revision
          ? { ...overview, profile: nextProfile }
          : overview,
      );
      void client.invalidateQueries({ queryKey: workspaceProfileKey });
      refresh();
    },
  });
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  // Keep a rejected submission visible until reload, even if a refetch shows a newer revision.
  const attempted = (mutation.isPending || conflict) &&
    draft?.baseRevision === mutation.variables?.values.expectedRevision;
  const activeDraft = draft?.baseRevision === committed.revision || attempted ? draft : undefined;
  const name = activeDraft?.name ?? committed.displayName ?? "";
  const zone = activeDraft?.zone ?? committedZone;
  const labels = { ...committed.accountLabels, ...activeDraft?.labels };
  const required = useRequiredFields();
  const nameDirty = name !== (committed.displayName ?? "");
  const zoneDirty = zone !== committedZone;
  const languageDirty = locale !== committed.locale;
  const labelsDirty = !sameStringRecord(labels, committed.accountLabels ?? {});
  const dirty = nameDirty || zoneDirty || languageDirty || labelsDirty;
  useBuildNavigationGuard(dirty);
  const savedRevision = mutation.isSuccess && mutation.data.revision === committed.revision;
  const saved = savedRevision && !dirty;

  function updateDraft(change: Partial<Omit<PreferencesDraft, "baseRevision">>) {
    setDraft({ ...activeDraft, ...change, baseRevision: activeDraft?.baseRevision ?? committed.revision });
  }
  return (
    <Panel title={t("个人偏好", "Preferences")}>
      <form noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (mutation.isPending || conflict || !required.validate(e.currentTarget)) return;
          const values: PreferencesSubmission["values"] = {
            expectedRevision: activeDraft?.baseRevision ?? committed.revision,
          };
          if (nameDirty) values.displayName = name.trim();
          if (labelsDirty) values.accountLabels = labels;
          if (languageDirty) values.locale = locale;
          if (zoneDirty) values.timezone = zone === "browser" ? browserTimeZone : zone;
          mutation.mutate({
            values,
            timeZonePreference: zoneDirty ? zone : undefined,
          });
        }}
      >
        <div className="flex flex-col gap-mx-lg">
          <div className="mx-form-grid">
            <TextField
              label={t("显示名称", "Display name")}
              name="displayName"
              autoComplete="nickname"
              error={required.missing(name) ? t("请输入显示名称。", "Enter a display name.") : undefined}
              value={name}
              maxLength={80}
              required
              onChange={(e) => updateDraft({ name: e.currentTarget.value })}
            />
            <SelectPicker
              label={t("界面语言", "Interface language")}
              value={locale}
              onChange={(v) => {
                if (v === "en" || v === "zh") setLocale(v);
              }}
              options={[
                { value: "zh", label: t("简体中文", "Chinese (Simplified)") },
                { value: "en", label: "English" },
              ]}
            />
            <SearchPicker
              label={t("时间显示", "Display timezone")}
              value={zone}
              onChange={(v) => updateDraft({ zone: v ?? "Europe/London" })}
              options={Array.from(
                new Set([
                  "browser",
                  "Europe/London",
                  "Asia/Shanghai",
                  "America/New_York",
                  "UTC",
                  committedZone,
                  zone,
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
            <TextField
              label={t("组合记账货币", "Portfolio reporting currency")}
              name="baseCurrency"
              value={committed.baseCurrency}
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
              {/* The default names are the ones every page shows when no name is set. */}
              {(["A", "B", "C"] as const).map((code) => ({ code, label: accountName(undefined, code) })).map((account) => (
                <TextField
                  key={account.code}
                  label={account.label}
                  name={`accountLabel-${account.code}`}
                  maxLength={60}
                  value={labels[account.code] ?? ""}
                  placeholder={account.label}
                  onChange={(e) => updateDraft({
                    labels: { ...activeDraft?.labels, [account.code]: e.currentTarget.value },
                  })}
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
              {conflict ? t(
                "设置已在其他窗口更新。重新加载后再保存。",
                "Settings changed in another window. Reload before saving.",
              ) : t(
                "未能保存偏好，请重试。",
                "Could not save preferences. Please retry.",
              )}
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-mx-md">
            <Button
              type="submit"
              disabled={
                conflict || (zone !== "browser" && !isValidTimeZone(zone))
              }
              loading={mutation.isPending}
              loadingLabel={t("保存中…", "Saving…")}
            >
              <CircleCheck size={16} aria-hidden="true" />
              {t("保存偏好", "Save preferences")}
            </Button>
            {savedRevision && dirty && (
              <span role="status">{t("还有未保存的修改", "You have unsaved changes")}</span>
            )}
          </div>
        </div>
      </form>
    </Panel>
  );
}
