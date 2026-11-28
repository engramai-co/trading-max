"use client";

import { FilePicker } from "@/components/ui/file-picker";
import { TextField, useRequiredFields } from "@/components/ui/form-field";

import { useBuildNavigationGuard } from "@/ui/publication-provider";
import { Switch } from "@/components/ui/switch";
import { CircleCheck, Upload } from "lucide-react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
import { useSettingsDrafts } from "./settings-draft-provider";
import { SettingsLoading } from "./settings-loading";
import {
  Facts,
  Freshness,
  Metric,
  Notice,
  Panel,
  Pending,
  QueryError,
  QueryReadStatus,
  Tag,
  useCopy,
} from "./foundation";
import { SearchPicker, SelectPicker } from "./picker";
import {
  settingsFormGridClass,
  settingsImportDropClass,
  settingsRetryLinkClass,
  settingsRowClass,
  settingsRowHeadingClass,
  settingsSwitchOffsetClass,
  guardSettingsFormEnter,
} from "./settings-styles";

type ScheduleSaveRequest = {
  change: Record<string, boolean>;
  expectedRevision?: number;
};

type NoticeSaveRequest = {
  enabled: boolean;
  expectedRevision?: number;
};

export function AutomationPreferences({ active }: { active: boolean }) {
  const t = useCopy();
  const client = useQueryClient();
  const retrying = useRef(false);
  const query = useQuery({
    queryKey: ["workspace-automation"],
    enabled: active,
    queryFn: ({ signal }) => api<AutomationSettings>("/settings/automation", { signal }),
    retry: 1,
  });
  const save = (change: Record<string, boolean>, expectedRevision?: number) =>
    api<AutomationSettings>(
      "/settings/automation",
      jsonRequest("PUT", {
        ...change,
        expectedRevision: expectedRevision ?? query.data?.revision,
      }),
    );
  const mutation = useMutation({
    mutationFn: ({ change, expectedRevision }: ScheduleSaveRequest) => save(change, expectedRevision),
    onSuccess: (settings) => {
      client.setQueryData(["workspace-automation"], settings);
    },
  });
  // Notices of new evidence are local: they compare saved models with new data and never call a model.
  const notices = useMutation({
    mutationFn: ({ enabled, expectedRevision }: NoticeSaveRequest) =>
      save({ evidenceNoticesEnabled: enabled }, expectedRevision),
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
  const saving = mutation.isPending || notices.isPending;
  if (!active && !s) return null;

  async function retrySave<T extends { expectedRevision?: number }>(
    attempted: T | undefined,
    reapply: (request: T) => void,
  ) {
    if (!attempted || saving || retrying.current || query.isFetching) return;
    retrying.current = true;
    try {
      const latest = await query.refetch();
      if (latest.isSuccess) reapply({ ...attempted, expectedRevision: latest.data.revision });
    } finally {
      retrying.current = false;
    }
  }

  return (
    <>
      <QueryReadStatus label={t("自动更新", "Automatic updates")} failed={query.isError && !s}
        refreshFailed={query.isRefetchError} ready={Boolean(s) && !query.isError} error={query.error} />
      {!s ? (
        query.isPending ? <SettingsLoading section="automation" /> : <QueryError retry={query.refetch} error={query.error} />
      ) : <>
        {query.isError && (
          <Notice tone="warn">
            {t("更新计划未能重新载入。", "Update schedule could not be reloaded.")}{" "}
            <button
              type="button"
              className={settingsRetryLinkClass}
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t("重试", "Retry")}
            </button>
          </Notice>
        )}
        <Panel title={t("自动更新", "Automatic updates")}>
          {mutation.isError && (
            <Notice tone="bad">
              {t(
                "未能保存更新计划。获取最新设置后可重新应用。",
                "Could not save the schedule. Reload the latest revision to reapply.",
              )}{" "}
              <button
                type="button"
                className={settingsRetryLinkClass}
                disabled={saving || query.isFetching}
                onClick={() => void retrySave(mutation.variables, mutation.mutate)}
              >
                {t("重试", "Retry")}
              </button>
            </Notice>
          )}
          {rows.map((row) => (
            <div className={settingsRowClass} key={row.key}>
              <div className="min-w-0">
                <h3 className={settingsRowHeadingClass}>{row.title}</h3>
              </div>
              <Switch
                className={settingsSwitchOffsetClass}
                aria-label={row.title}
                checked={
                  mutation.isPending &&
                  mutation.variables &&
                  row.key in mutation.variables.change
                    ? mutation.variables.change[row.key]
                    : row.enabled
                }
                // Both panels save revisions of the same settings, one at a time.
                saving={mutation.isPending && row.key in (mutation.variables?.change ?? {})}
                disabled={saving || query.isFetching}
                onCheckedChange={(checked) => mutation.mutate({ change: { [row.key]: checked } })}
              />
            </div>
          ))}
          <Link className="mx-text-link" href="/health">
            {t("查看运行时间与更新记录", "See the schedule and update history")}
          </Link>
          <div className="text-xs leading-[1.9] text-muted-foreground" role="status">
            {mutation.isPending
              ? t("正在保存…", "Saving…")
              : mutation.isSuccess
                ? t("更新计划已保存", "Schedule saved")
                : null}
          </div>
        </Panel>
        <Panel
          title={t("提醒", "Notices")}
          help={
            <>
              <p>
                {t(
                  "已存估值模型之后出现新报表、所用那一期被重述，或一致预期比保存时变动一档（EPS 5%，营收增长 2 个百分点）时，研究清单和「看新证据」旁会出现一个点。同一证据只提示一次。",
                  "A dot appears in the research list and beside See new evidence when a saved valuation model has new statements, a restatement of its period, or a consensus move of a full step since it was saved (5% for EPS, two percentage points for revenue growth). Each piece of evidence is announced once.",
                )}
              </p>
              <p>
                {t(
                  "只在本机比较：不调用模型，不起草，也不保存模型。",
                  "Compared on this machine: no model is contacted, and nothing is drafted or saved.",
                )}
              </p>
            </>
          }
          helpBasis={t(
            "报表和一致预期来自研究数据，EPS 一致预期的变化来自本地预期记录。公司指引没有单独的数据源，它体现在新报表和一致预期的变化里。",
            "Statements and consensus come from the research data; EPS consensus changes come from the local estimate record. Company guidance has no separate source: it shows through new statements and consensus revisions.",
          )}
        >
          {notices.isError && (
            <Notice tone="bad">
              {t(
                "未能保存提醒设置。获取最新设置后可重新应用。",
                "Could not save the notice setting. Reload the latest revision to reapply.",
              )}{" "}
              <button
                type="button"
                className={settingsRetryLinkClass}
                disabled={saving || query.isFetching}
                onClick={() => void retrySave(notices.variables, notices.mutate)}
              >
                {t("重试", "Retry")}
              </button>
            </Notice>
          )}
          <div className={settingsRowClass}>
            <div className="min-w-0">
              <h3 className={settingsRowHeadingClass}>
                {t("已存估值模型的新证据", "New evidence for saved valuation models")}
              </h3>
            </div>
            <Switch
              className={settingsSwitchOffsetClass}
              aria-label={t("已存估值模型的新证据", "New evidence for saved valuation models")}
              checked={notices.isPending ? notices.variables.enabled : s.evidenceNoticesEnabled}
              saving={notices.isPending}
              disabled={saving || query.isFetching}
              onCheckedChange={(checked) => notices.mutate({ enabled: checked })}
            />
          </div>
          <div className="text-xs leading-[1.9] text-muted-foreground" role="status">
            {notices.isPending
              ? t("正在保存…", "Saving…")
              : notices.isSuccess
                ? t("提醒设置已保存", "Notice setting saved")
                : null}
          </div>
        </Panel>
      </>}
    </>
  );
}

const cfdImportsKey = ["workspace-cfd-imports"] as const;
const cfdUploadKey = [...cfdImportsKey, "upload"] as const;

export function CfdImports({
  active = true,
  desktop = false,
  readOnly = false,
  file: controlledFile,
  onFileChange,
}: {
  active?: boolean;
  desktop?: boolean;
  readOnly?: boolean;
  file?: File | null;
  onFileChange?: Dispatch<SetStateAction<File | null>>;
}) {
  const t = useCopy();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: cfdImportsKey,
    enabled: active,
    queryFn: () => api<CfdImportStatus>("/imports/trading212/cfd"),
    retry: 1,
  });
  const [uncontrolledFile, setUncontrolledFile] = useState<File | null>(null);
  const file = onFileChange ? (controlledFile ?? null) : uncontrolledFile;
  const setFile = onFileChange ?? setUncontrolledFile;
  useBuildNavigationGuard(Boolean(file));
  const [imported, setImported] = useState<"imported" | "duplicate" | null>(null);
  const importing = useIsMutating({ mutationKey: cfdUploadKey }) > 0;
  const upload = useMutation({
    mutationKey: cfdUploadKey,
    gcTime: 0,
    mutationFn: async (file: File) => {
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
    onSuccess: (result, submitted) => {
      setImported(result.status);
      setFile((selected) => selected === submitted ? null : selected);
      void client.invalidateQueries({ queryKey: cfdImportsKey });
    },
  });
  const preference = useMutation({
    mutationFn: (accountStatus: string) =>
      api("/settings/cfd", jsonRequest("PUT", { accountStatus })),
    onSuccess: () => void query.refetch(),
  });
  const data = query.data;
  if (!active && !data) return null;
  // A retired account's ledger is history: its counts stay with the import records.
  const retired = data?.accountStatus === "retired";
  const counts: Array<[string, string]> = data
    ? [
        [t("已导入文件", "Imported files"), number(data.importedFiles, 0)],
        [t("独立事件", "Unique events"), number(data.uniqueEvents, 0)],
        [t("已去重事件", "Duplicates removed"), number(data.duplicateEvents, 0)],
      ]
    : [];
  const title = t("CFD 历史账本", "CFD history ledger");
  return (
    <>
      <QueryReadStatus label={title} failed={query.isError} ready={Boolean(data) && !query.isError} error={query.error} />
      {query.isPending && onFileChange ? <SettingsLoading section="cfd" /> : <Panel title={title}>
        {query.isPending ? (
            <Pending compact />
          ) : query.isError ? (
            <QueryError retry={query.refetch} error={query.error} />
          ) : (
            data && (
              <div className="flex flex-col gap-mx-lg">
                <div className="mx-toolbar">
                  {data.isStale && !retired && (
                    <Tag tone="warn">{t("记录需要更新", "History needs updating")}</Tag>
                  )}
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
                {desktop && (
                  <ol className="mx-import-steps" aria-label={t("导入步骤", "Import steps")}>
                    <li data-current={!file && !imported}>{t("1 · 选择 CSV", "1 · Choose CSV")}</li>
                    <li data-current={Boolean(file)}>{t("2 · 确认导入", "2 · Import")}</li>
                    <li data-current={Boolean(imported)}>{t("3 · 更新复盘", "3 · Update review")}</li>
                  </ol>
                )}
                <div className={settingsImportDropClass}>
                  <Upload size={20} className="m-[3px] self-center text-link" aria-hidden="true" />
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
                    disabled={importing || readOnly}
                  />
                  <Button
                    type="button"
                    className="col-start-2 justify-self-start max-[767px]:col-start-1"
                    disabled={!file || readOnly}
                    loading={importing}
                    loadingLabel={t("导入中…", "Importing…")}
                    onClick={() => {
                      if (file && !client.isMutating({ mutationKey: cfdUploadKey })) upload.mutate(file);
                    }}
                  >
                    <Upload size={16} aria-hidden="true" />
                    {t("导入账本", "Import ledger")}
                  </Button>
                  {desktop && file && (
                    <p className="min-w-0 wrap-anywhere text-xs leading-[1.9] text-muted-foreground col-start-2 max-[767px]:col-start-1">
                      {file.name} · {number(file.size / 1024, 1)} KB ·{" "}
                      {t(
                        "确认后写入当前工作区，重复文件会跳过。",
                        "Import into this workspace; duplicate files will be skipped.",
                      )}
                    </p>
                  )}
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
                {desktop && imported && (
                  <div className="flex flex-wrap items-center gap-mx-md">
                    <Link href="/health?scope=cfd" data-slot="button" className={buttonVariants()}>
                      {t("更新 CFD 复盘", "Update CFD review")}
                    </Link>
                    <Link
                      href="/review?account=C"
                      data-slot="button"
                      className={buttonVariants({ variant: "ghost" })}
                    >
                      {t("查看复盘", "View review")}
                    </Link>
                  </div>
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
                  <summary>{t("查看导入记录与覆盖范围", "Import history & coverage")}</summary>
                  <Facts
                    rows={[
                      ...(retired ? counts : []),
                      [
                        t("历史覆盖", "History coverage"),
                        (data.coverageStartDate?.slice(0, 10) ?? "—") +
                          " → " +
                          (data.coverageEndDate?.slice(0, 10) ?? "—"),
                      ],
                      [t("原始记录数", "Raw records"), number(data.totalRawRows, 0)],
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
                            <th scope="col">{t("文件", "File")}</th>
                            <th scope="col">{t("导入时间", "Imported")}</th>
                            <th scope="col" className="mx-align-right">
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
                              <td className="mx-align-right">{number(f.rawRows, 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mt-3 border-t border-border pt-3 text-xs leading-[1.6] text-muted-foreground">
                      {t("尚未导入任何文件", "No imports yet")}
                    </p>
                  )}
                </details>
              </div>
            )
          )}
      </Panel>}
    </>
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
  const { preferences: draft, setPreferences: setDraft, language, setLanguage } = useSettingsDrafts();
  const [accepted, setAccepted] = useState<UserProfile>();
  const committed = accepted && accepted.revision > profile.revision ? accepted : profile;
  const committedZone =
    timeZonePreference === "browser" && committed.timezone === browserTimeZone
      ? "browser"
      : (committed.timezone ?? timeZonePreference);
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
      if (submitted.values.locale) {
        setLanguage((current) => current?.selected === submitted.values.locale ? undefined : current);
      }
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
  const attempted =
    (mutation.isPending || conflict) &&
    draft?.baseRevision === mutation.variables?.values.expectedRevision;
  const activeDraft = draft?.baseRevision === committed.revision || attempted ? draft : undefined;
  useEffect(() => {
    if (draft && !activeDraft && draft.baseRevision < committed.revision) {
      setDraft((current) => current === draft ? undefined : current);
    }
  }, [activeDraft, committed.revision, draft, setDraft]);
  const name = activeDraft?.name ?? committed.displayName ?? "";
  const zone = activeDraft?.zone ?? committedZone;
  const labels = { ...committed.accountLabels, ...activeDraft?.labels };
  const required = useRequiredFields();
  const nameMissingMsg = t("请输入显示名称。", "Enter a display name.");
  const nameDirty = name !== (committed.displayName ?? "");
  const zoneDirty = zone !== committedZone;
  const languageDirty = locale !== committed.locale;
  const labelsDirty = !sameStringRecord(labels, committed.accountLabels ?? {});
  const dirty = nameDirty || zoneDirty || languageDirty || labelsDirty || Boolean(language);
  useBuildNavigationGuard(dirty);
  const savedRevision = mutation.isSuccess && mutation.data.revision === committed.revision;
  const saved = savedRevision && !dirty;
  const showUnsaved = nameDirty || zoneDirty || labelsDirty || Boolean(language) || (savedRevision && dirty);

  function updateDraft(change: Partial<Omit<PreferencesDraft, "baseRevision">>) {
    const next = { ...activeDraft, ...change, baseRevision: activeDraft?.baseRevision ?? committed.revision };
    if (!mutation.isPending) {
      if (next.name === (committed.displayName ?? "")) delete next.name;
      if (next.zone === committedZone) delete next.zone;
      if (next.labels && sameStringRecord({ ...committed.accountLabels, ...next.labels }, committed.accountLabels ?? {})) delete next.labels;
    }
    setDraft(next.name !== undefined || next.zone !== undefined || next.labels ? next : undefined);
  }

  function discardDraft() {
    setDraft(undefined);
    setLanguage(undefined);
    required.reset();
    mutation.reset();
    if (language && locale === language.selected) setLocale(language.previous);
  }

  return (
    <Panel title={t("个人偏好", "Preferences")}>
      <form
        method="post"
        noValidate
        aria-label={t("个人偏好", "Preferences")}
        onKeyDown={guardSettingsFormEnter}
        onSubmit={(e) => {
          e.preventDefault();
          if (mutation.isPending || conflict || !required.validate(e.currentTarget)) return;
          const values: PreferencesSubmission["values"] = {
            expectedRevision: activeDraft?.baseRevision ?? committed.revision,
          };
          if (nameDirty) values.displayName = name.trim();
          if (labelsDirty) values.accountLabels = labels;
          if (languageDirty || language) values.locale = locale;
          if (zoneDirty) values.timezone = zone === "browser" ? browserTimeZone : zone;
          mutation.mutate({
            values,
            timeZonePreference: zoneDirty ? zone : undefined,
          });
        }}
      >
        <div className="flex flex-col gap-mx-lg">
          <div className={settingsFormGridClass}>
            <TextField
              label={t("显示名称", "Display name")}
              name="displayName"
              autoComplete="nickname"
              error={required.missing(name, "displayName") ? nameMissingMsg : undefined}
              value={name}
              maxLength={80}
              required
              onChange={(e) => {
                const value = e.currentTarget.value;
                required.markEdited("displayName", value);
                updateDraft({ name: value });
              }}
              onBlur={(e) => required.markBlurred("displayName", e.currentTarget.value, nameMissingMsg, e)}
            />
            <SelectPicker
              label={t("界面语言", "Interface language")}
              value={locale}
              onChange={(v) => {
                if (v === "en" || v === "zh") {
                  const previous = language?.previous ?? locale;
                  setLanguage(v === previous ? undefined : { previous, selected: v });
                  setLocale(v);
                }
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
                    ? t("跟随设备", "Use device timezone") + " · " + browserTimeZone
                    : value,
              }))}
            />
            <TextField
              label={t("组合记账货币", "Portfolio reporting currency")}
              description={t("由账户快照决定", "Determined by account snapshots")}
              value={committed.baseCurrency}
              readOnly
              className="border-transparent bg-transparent tabular-nums"
            />
          </div>
          {required.liveRegion}
          <div>
            <h3 className={settingsRowHeadingClass}>
              {t("账户显示名称", "Account display names")}
            </h3>
            <div className={settingsFormGridClass}>
              {/* The default names are the ones every page shows when no name is set. */}
              {(["A", "B", "C"] as const)
                .map((code) => ({ code, label: accountName(undefined, code) }))
                .map((account) => (
                  <TextField
                    key={account.code}
                    label={account.label}
                    name={`accountLabel-${account.code}`}
                    maxLength={60}
                    value={labels[account.code] ?? ""}
                    placeholder={account.label}
                    onChange={(e) =>
                      updateDraft({
                        labels: { ...activeDraft?.labels, [account.code]: e.currentTarget.value },
                      })
                    }
                  />
                ))}
            </div>
          </div>
          {saved && (
            <Notice tone="good">{t("个人偏好已保存。", "Preferences saved.")}</Notice>
          )}
          {mutation.isError && (
            <Notice tone="bad">
              {conflict
                ? t(
                    "设置已在其他窗口更新。重新加载后再保存。",
                    "Settings changed in another window. Reload before saving.",
                  )
                : t("未能保存偏好，请重试。", "Could not save preferences. Please retry.")}
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-mx-md">
            <Button
              type="submit"
              disabled={conflict || (zone !== "browser" && !isValidTimeZone(zone))}
              loading={mutation.isPending}
              loadingLabel={t("保存中…", "Saving…")}
            >
              <CircleCheck size={16} aria-hidden="true" />
              {t("保存偏好", "Save preferences")}
            </Button>
            {showUnsaved && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={discardDraft}
                >
                  {t("放弃修改", "Discard changes")}
                </Button>
                <span role="status" className="text-xs text-muted-foreground">
                  {t("还有未保存的修改", "You have unsaved changes")}
                </span>
                {language && (
                  <span className="text-xs text-muted-foreground">
                    {t("语言已预览。保存偏好后会写入个人资料。", "Language is previewed immediately. Save preferences to update your profile.")}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </form>
    </Panel>
  );
}
