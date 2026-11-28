"use client";

import { WorkspaceAlertDialog, WorkspaceDialog, WorkspaceSheet } from "./overlay";
import { CredentialField, useRequiredFields } from "@/components/ui/form-field";
import { useBuildNavigationGuard } from "@/ui/publication-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { TabsContent } from "@/components/ui/tabs";
import {
  ArrowRight,
  CircleCheck,
  Link2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "./link";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type {
  IntegrationOverview,
  IntegrationSummary,
  LLMProviderDescriptor,
  LLMRoutePolicy,
} from "@/lib/types";
import { api, ApiError, jsonRequest } from "@/workspace/data";
import {
  Empty,
  Freshness,
  Notice,
  Page,
  Panel,
  QueryError,
  QueryReadStatus,
  Segments,
  Tabs,
  TabsScope,
  Tag,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import { accountName } from "./profile";
import {
  AutomationPreferences,
  CfdImports,
  PersonalPreferences,
} from "./settings-preferences";

import { OpenAIOAuthConnection } from "./settings-oauth";

import { IndexMarketData } from "./settings-index-data";
import { ReconstructionMarketData } from "./settings-market-data";

import { LocalOnboarding } from "./local-onboarding";
import { ASSISTANT_NAME } from "./assistant-settings";
import {
  reconcileModelRoutingDraft,
  sameStringRecord,
  type ModelRoutingSubmission,
} from "./settings-drafts";
import { settingsKey } from "./settings-query";
import { useSettingsDrafts } from "./settings-draft-provider";
import { SettingsLoading } from "./settings-loading";
import { SearchPicker, SelectPicker } from "./picker";
import {
  settingsBrokerKeyHelpClass,
  settingsConnectionCardClass,
  settingsConnectionCopyClass,
  settingsConnectionGridClass,
  settingsConnectionTitleClass,
  settingsDangerZoneClass,
  settingsFormGridClass,
  settingsModelGridClass,
  settingsRetryLinkClass,
  settingsRowClass,
  settingsRowCopyClass,
  settingsRowHeadingClass,
  guardSettingsFormEnter,
} from "./settings-styles";

const settingsTabPanelClass = "mx-tab-content mx-tab-panel [&[hidden]]:hidden!";

const AssistantPreferences = dynamic(
  () => import("./settings-assistant").then((module) => module.AssistantPreferences),
  { loading: () => <SettingsLoading section="assistant" /> },
);

type Connection =
  | {
      kind: "broker";
      profile: "invest" | "isa";
      title: string;
      existing?: IntegrationSummary;
    }
  | {
      kind: "model";
      provider: LLMProviderDescriptor;
      title: string;
      existing?: IntegrationSummary;
      useAsDefault?: boolean;
    };
type TestResult = {
  status: "succeeded" | "failed";
  validationToken: string | null;
};
type SavedBanner = {
  kind: "broker" | "model";
  result: "saved" | "disconnected";
};

function isConnectedIntegration(integration?: IntegrationSummary) {
  return Boolean(integration?.configured && integration.enabled && !integration.needsSecret);
}

export function SettingsWorkspace({
  localWorkspace = false,
  desktop = false,
}: {
  localWorkspace?: boolean;
  desktop?: boolean;
}) {
  const t = useCopy();
  const { params, update } = useRouteState();
  const tabs = [
    { value: "accounts", label: t("账户与数据", "Accounts & data") },
    { value: "models", label: t("模型连接", "Model connections") },
    { value: "assistant", label: ASSISTANT_NAME },
    { value: "automation", label: t("更新计划", "Update schedule") },
    { value: "preferences", label: t("个人偏好", "Preferences") },
  ];
  const view = tabs.some((tab) => tab.value === params.get("tab"))
    ? params.get("tab")!
    : "accounts";
  const client = useQueryClient();
  const needsIntegrations = view !== "assistant" && view !== "automation";
  const query = useQuery({
    queryKey: settingsKey,
    enabled: needsIntegrations,
    queryFn: ({ signal }) => api<IntegrationOverview>("/settings/integrations", { signal }),
    retry: 1,
  });
  const [connection, setConnection] = useState<Connection | null>(null);
  const { cfdFile, setCfdFile } = useSettingsDrafts();
  useBuildNavigationGuard(Boolean(connection));
  const [saved, setSaved] = useState<SavedBanner | null>(null);
  const [offerModelConnection, setOfferModelConnection] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const modelSetupTriggerRef = useRef<HTMLButtonElement>(null);
  const connectionTrigger = useRef<HTMLElement | null>(null);
  const pendingProvider = useRef<LLMProviderDescriptor | null>(null);
  const data = query.data;
  const hasModelConnection = data?.llmProviders.some((provider) =>
    data.integrations.some(
      (item) => item.provider === provider.provider && isConnectedIntegration(item),
    ),
  );
  const visibleProviders =
    data?.llmProviders.filter((provider) => provider.provider !== "openai-codex") ?? [];

  function openModel(provider: LLMProviderDescriptor, trigger: HTMLElement | null, first = false) {
    connectionTrigger.current = trigger;
    const existingApi = data?.integrations.some(
      (item) => item.provider === "openai" && item.configured && item.enabled,
    );
    const existingOAuth = data?.integrations.some(
      (item) => item.provider === "openai-codex" && item.configured && item.enabled,
    );
    const chosen =
      provider.provider === "openai" && (!existingApi || existingOAuth)
        ? (data?.llmProviders.find((item) => item.provider === "openai-codex") ?? provider)
        : provider;
    setSaved(null);
    setConnection({
      kind: "model",
      title: provider.label,
      provider: chosen,
      existing: data?.integrations.find((item) => item.provider === chosen.provider),
      useAsDefault:
        first ||
        !hasModelConnection ||
        data?.llmRoutePolicy?.defaultRoute.startsWith(chosen.provider + "/"),
    });
  }

  function openModelDirect(provider: LLMProviderDescriptor, trigger: HTMLButtonElement) {
    connectionTrigger.current = trigger;
    setSaved(null);
    setConnection({
      kind: "model",
      title: provider.provider === "openai-codex" ? "OpenAI" : provider.label,
      provider,
      existing: data?.integrations.find((item) => item.provider === provider.provider),
      useAsDefault:
        !hasModelConnection ||
        data?.llmRoutePolicy?.defaultRoute.startsWith(provider.provider + "/"),
    });
  }

  const integrationNotices = (
    <>
      {saved && (
        <Notice tone="good">
          {saved.result === "disconnected" ? (
            t(
              "连接已断开。已保存的快照仍可查看。",
              "Connection removed. Saved snapshots remain available.",
            )
          ) : saved.kind === "broker" ? (
            <>
              {localWorkspace
                ? t(
                    "凭据已保存。请完成首次同步并核对账户金额，数据就绪后即可查看。",
                    "Credentials saved. Complete the first sync and check balances to make data ready.",
                  )
                : t(
                    "凭据已保存。数据将在下一次更新通过就绪检查后可用。",
                    "Credentials saved. Data becomes ready after the next update passes readiness checks.",
                  )}{" "}
              {localWorkspace ? (
                <a href="#local-onboarding" className="mx-text-link">
                  {t("前往首次同步", "Go to first sync")}
                </a>
              ) : (
                <Link href="/health" className="mx-text-link">
                  {t("前往数据状态", "Go to Data status")}
                </Link>
              )}
            </>
          ) : (
            t(
              "连接已保存。下一次更新将使用新的设置。",
              "Connection saved. Your next update will use these settings.",
            )
          )}
        </Notice>
      )}
      {query.isError && data && (
        // A failed reload keeps the loaded page; one notice says so for every panel and offers the retry.
        <Notice tone="bad">
          {t("设置未能重新载入。", "Settings could not be reloaded.")}{" "}
          <button
            type="button"
            className={settingsRetryLinkClass}
            onClick={() => void query.refetch()}
          >
            {t("重试", "Retry")}
          </button>
        </Notice>
      )}
    </>
  );
  const onboarding = params.get("onboarding") === "1";
  function integrationFallback(section: "accounts" | "models" | "preferences") {
    return query.isPending
      ? <SettingsLoading section={section} desktop={desktop} onboarding={onboarding} />
      : <QueryError retry={query.refetch} error={query.error} />;
  }

  return (
    <Page
      className="mx-settings-page"
      title={desktop ? t("工作区设置", "Workspace settings") : t("设置", "Settings")}
      description={
        desktop
          ? t(
              "账户连接与更新计划保存在当前服务；App 的启动与连接切换在 ⌘, 中管理。",
              "Accounts and schedules belong to the selected service. Manage App startup and workspace switching with ⌘,.",
            )
          : undefined
      }
    >
      <TabsScope
        value={view}
        onChange={(value) => {
          setOfferModelConnection(false);
          update({ tab: value });
        }}
      >
        <Tabs label={t("设置分类", "Settings sections")} value={view} options={tabs} />
        <QueryReadStatus
          label={t("设置", "Settings")}
          failed={needsIntegrations && query.isError && !data}
          ready={needsIntegrations && Boolean(data) && !query.isError}
          error={query.error}
        />
        <TabsContent value="accounts" keepMounted className={settingsTabPanelClass}>
          {view === "accounts" && integrationNotices}
          {view === "accounts" && localWorkspace && (
            <LocalOnboarding pending={<SettingsLoading section="local-onboarding" />} />
          )}
          {data && view === "accounts" ? (
            <>
              <Panel title={t("Trading\u00a0212 账户", "Trading\u00a0212 accounts")}>
                <div className={settingsConnectionGridClass}>
                  {(["invest", "isa"] as const).map((profile) => {
                    const existing = data.integrations.find(
                      (i) => i.provider === "trading212" && i.profile === profile,
                    );
                    const name = accountName(data.profile, profile === "invest" ? "A" : "B");
                    return (
                      <ConnectionCard
                        key={profile}
                        title={name}
                        integration={existing}
                        nextStep={t(
                          "连接后，前往数据状态开始更新。",
                          "Once connected, start an update in Data status.",
                        )}
                        onOpen={(trigger) => {
                          connectionTrigger.current = trigger;
                          setSaved(null);
                          setConnection({
                            kind: "broker",
                            profile,
                            title: name,
                            existing,
                          });
                        }}
                      />
                    );
                  })}
                </div>
              </Panel>
              {params.get("onboarding") !== "1" && (
                <>
                  <Panel title={t("公开市场数据", "Public market data")}>
                    <div className={settingsRowClass}>
                      <div className="min-w-0">
                        <h3 className={settingsRowHeadingClass}>
                          {t(
                            "Yahoo Finance 兼容数据源",
                            "Yahoo Finance-compatible source",
                          )}
                        </h3>
                      </div>
                      <Link
                        href="/research"
                        data-slot="button"
                        className={buttonVariants({ variant: "ghost" })}
                      >
                        {t("查看研究", "View research")}
                        <ArrowRight size={16} aria-hidden="true" />
                      </Link>
                    </div>
                  </Panel>
                  <ReconstructionMarketData
                    integration={data.integrations.find((item) => item.provider === "alpaca")}
                  />
                  <IndexMarketData
                    integration={data.integrations.find((item) => item.provider === "eodhd")}
                  />
                </>
              )}
            </>
          ) : view === "accounts" && integrationFallback("accounts")}
          {data && !desktop && params.get("onboarding") !== "1" && (
            <CfdImports active={view === "accounts"} file={cfdFile} onFileChange={setCfdFile} />
          )}
        </TabsContent>
        <TabsContent value="models" keepMounted className={settingsTabPanelClass}>
          {view === "models" && integrationNotices}
          {data ? (
            <>
              <Panel
                title={t("模型连接（可选）", "Model connections (optional)")}
                action={
                  !hasModelConnection && visibleProviders.length > 0 ? (
                    <Button
                      ref={modelSetupTriggerRef}
                      type="button"
                      variant="secondary"
                      onClick={() => setOfferModelConnection(true)}
                    >
                      {t("选择提供商", "Choose a provider")}
                    </Button>
                  ) : undefined
                }
              >
                <div className={settingsModelGridClass}>
                  {visibleProviders.map((provider) => (
                    <ConnectionCard
                      key={provider.provider}
                      title={provider.label}
                      connectLabel={t("连接模型", "Connect model")}
                      subtitle={provider.defaultModel}
                      nextStep={t(
                        "连接后，在下方为研究用途选择模型。",
                        "Once connected, choose a model for each research task below.",
                      )}
                      integration={
                        (provider.provider === "openai"
                          ? data.integrations.find(
                              (i) =>
                                i.provider === "openai-codex" && i.configured && i.enabled,
                            )
                          : undefined) ??
                        data.integrations.find((i) => i.provider === provider.provider)
                      }
                      onOpen={(trigger) => openModel(provider, trigger)}
                    />
                  ))}
                </div>
                {!data.llmProviders.length && (
                  <Empty
                    title={t("暂无可用模型提供商", "No model providers available")}
                  />
                )}
              </Panel>
              {data.llmRoutePolicy && (
                <ModelRouting
                  policy={data.llmRoutePolicy}
                  providers={data.llmProviders}
                  integrations={data.integrations}
                  onConnectProvider={openModelDirect}
                  refresh={() => void query.refetch()}
                />
              )}
            </>
          ) : view === "models" && integrationFallback("models")}
        </TabsContent>
        <TabsContent value="assistant" keepMounted className={settingsTabPanelClass}>
          {view === "assistant" && (
            <AssistantPreferences
              openModels={() => {
                setOfferModelConnection(true);
                update({ tab: "models" });
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="automation" keepMounted className={settingsTabPanelClass}>
          <AutomationPreferences active={view === "automation"} />
        </TabsContent>
        <TabsContent value="preferences" keepMounted className={settingsTabPanelClass}>
          {view === "preferences" && integrationNotices}
          {data ? (
            <PersonalPreferences profile={data.profile} refresh={() => void query.refetch()} />
          ) : view === "preferences" && integrationFallback("preferences")}
        </TabsContent>
      </TabsScope>
      <WorkspaceDialog
        open={
          view === "models" &&
          Boolean(data?.llmProviders.length) &&
          !hasModelConnection &&
          offerModelConnection &&
          !connection
        }
        onClose={() => setOfferModelConnection(false)}
        onClosed={() => {
          const provider = pendingProvider.current;
          pendingProvider.current = null;
          if (provider && view === "models") openModel(provider, modelSetupTriggerRef.current, true);
        }}
        finalFocus={modelSetupTriggerRef}
        title={t("连接你的模型", "Connect your model")}
        className="mx-model-provider-dialog"
      >
        <div className="flex flex-col gap-mx-lg">
          <p>
            {t(
              "选择你想使用的提供商。OpenAI 支持 ChatGPT 登录或 API Key；你也可以稍后再设置。",
              "Choose a provider. OpenAI supports ChatGPT sign-in or an API key. You can also set this up later.",
            )}
          </p>
          <SelectPicker
            data-autofocus
            label={t("模型提供商", "Model provider")}
            value={selectedProvider}
            onChange={(value) => setSelectedProvider(value ?? "openai")}
            options={
              visibleProviders.map((provider) => ({
                value: provider.provider,
                label: provider.label,
              })) ?? []
            }
          />
          <div className="flex flex-wrap items-center justify-end gap-mx-md">
            <Button type="button" variant="ghost" onClick={() => setOfferModelConnection(false)}>
              {t("稍后设置", "Set up later")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const provider = data?.llmProviders.find(
                  (item) => item.provider === selectedProvider,
                );
                if (!provider) return;
                pendingProvider.current = provider;
                setOfferModelConnection(false);
              }}
            >
              {t("继续连接", "Continue")}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </WorkspaceDialog>
      <WorkspaceSheet
        open={connection !== null}
        onClose={() => setConnection(null)}
        title={connection ? t("连接 ", "Connect ") + connection.title : ""}
        finalFocus={() => connectionTrigger.current?.isConnected ? connectionTrigger.current : true}
        className="mx-connection-sheet"
        width={480}
      >
        {connection && (
          <div className="flex flex-col gap-mx-lg">
            {connection.kind === "model" &&
              ["openai", "openai-codex"].includes(connection.provider.provider) && (
                <Segments
                  fullWidth
                  selection="radio"
                  label={t("OpenAI 连接方式", "OpenAI connection method")}
                  value={connection.provider.provider}
                  options={[
                    { value: "openai-codex", label: t("ChatGPT 登录", "ChatGPT sign-in") },
                    { value: "openai", label: "API Key" },
                  ]}
                  onChange={(value) => {
                    const provider = data?.llmProviders.find((item) => item.provider === value);
                    if (provider)
                      setConnection({
                        ...connection,
                        provider,
                        existing: data?.integrations.find((item) => item.provider === value),
                      });
                  }}
                />
              )}
            {connection.kind === "model" && connection.provider.authMethod === "oauth" ? (
              <OpenAIOAuthConnection
                provider={connection.provider}
                existing={connection.existing}
                useAsDefault={connection.useAsDefault}
                onSaved={(result) => {
                  setConnection(null);
                  setSaved({ kind: "model", result });
                  void client.invalidateQueries({ queryKey: settingsKey });
                }}
              />
            ) : (
              <ConnectionForm
                key={
                  connection.kind === "broker"
                    ? connection.profile
                    : connection.provider.provider
                }
                connection={connection}
                onSaved={(result) => {
                  const kind = connection.kind;
                  setConnection(null);
                  setSaved({ kind, result });
                  void client.invalidateQueries({ queryKey: settingsKey });
                }}
              />
            )}
          </div>
        )}
      </WorkspaceSheet>
    </Page>
  );
}

function ConnectionCard({
  title,
  subtitle,
  integration,
  onOpen,
  connectLabel,
  nextStep,
}: {
  title: string;
  subtitle?: string;
  integration?: IntegrationSummary;
  onOpen: (trigger: HTMLElement) => void;
  connectLabel?: string;
  nextStep: string;
}) {
  const t = useCopy();
  const connected = isConnectedIntegration(integration);
  const action = connected
    ? t("管理连接", "Manage connection")
    : connectLabel ?? t("连接账户", "Connect account");
  const testLabel = t("上次测试", "Last tested");
  return (
    <div className={settingsConnectionCardClass}>
      <div className="mx-toolbar">
        <h3 className={settingsConnectionTitleClass}>{title}</h3>
        <Tag
          tone={integration?.lastTestStatus === "failed" && !connected ? "warn" : "neutral"}
        >
          {connected
            ? t("已连接", "Connected")
            : integration?.needsSecret && integration.configured
              ? t("需要重新连接", "Reconnect needed")
              : t("未连接", "Not connected")}
        </Tag>
      </div>
      {subtitle && <p className={settingsConnectionCopyClass}>{subtitle}</p>}
      {!connected && <p className={settingsConnectionCopyClass}>{nextStep}</p>}
      {/* A connected card keeps its test row, reading Not tested until one has run, so loading and loaded share one height. */}
      {(connected || integration?.lastTestAt) && (integration?.lastTestAt ? (
        <Freshness date={integration.lastTestAt} label={testLabel} />
      ) : (
        <span className="mx-freshness">
          <span className="mx-status-dot" aria-hidden="true" />
          {testLabel}{" "}{t("未测试", "Not tested")}
        </span>
      ))}
      <Button
        type="button"
        variant={connected ? "outline" : "default"}
        className="mt-2.5 self-start max-[767px]:mt-1"
        aria-label={action + t("：", ": ") + title}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <Link2 size={16} aria-hidden="true" />
        {action}
      </Button>
    </div>
  );
}

function ConnectionForm({
  connection,
  onSaved,
}: {
  connection: Connection;
  onSaved: (result: "saved" | "disconnected") => void;
}) {
  const t = useCopy();
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [environment, setEnvironment] = useState("live");
  const [model, setModel] = useState(
    connection.kind === "model"
      ? (connection.existing?.model ?? connection.provider.defaultModel)
      : "",
  );
  const [token, setToken] = useState<string | null>(null);
  const [useAsDefault, setUseAsDefault] = useState(
    connection.kind === "model" && Boolean(connection.useAsDefault),
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const path =
    connection.kind === "broker"
      ? "/settings/integrations/trading212/" + connection.profile
      : "/settings/llm/providers/" + connection.provider.provider;
  const payload =
    connection.kind === "broker"
      ? { apiKeyId: apiKey.trim(), secretKey: secretKey.trim(), environment }
      : { apiKey: apiKey.trim(), model };
  const test = useMutation({
    gcTime: 0,
    mutationFn: () => api<TestResult>(path + "/test", jsonRequest("POST", payload)),
    onSuccess: (result) =>
      setToken(result.status === "succeeded" ? result.validationToken : null),
  });
  const save = useMutation({
    gcTime: 0,
    mutationFn: () =>
      api(
        path,
        jsonRequest("PUT", {
          ...payload,
          enabled: true,
          validationToken: token,
          ...(connection.kind === "model" ? { useAsDefault } : {}),
        }),
      ),
    onSuccess: () => {
      setApiKey("");
      setSecretKey("");
      setToken(null);
      onSaved("saved");
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: () => onSaved("disconnected"),
  });
  const busy = test.isPending || save.isPending;
  const required = useRequiredFields();
  const keyFieldName =
    connection.kind === "broker"
      ? `trading212-${connection.profile}-key-id`
      : `model-${connection.provider.provider}-api-key`;
  const secretFieldName =
    connection.kind === "broker" ? `trading212-${connection.profile}-secret` : "";
  const keyMissingMsg = t("请输入 API 密钥。", "Enter the API key.");
  const secretMissingMsg = t("请输入 API Secret。", "Enter the API secret.");

  function edit(update: () => void, field?: string, value?: string) {
    update();
    if (field) required.markEdited(field, value);
    setToken(null);
    test.reset();
    save.reset();
  }

  function runTest(form: HTMLFormElement | null) {
    if (busy || !required.validate(form) || (connection.kind === "model" && !model)) return;
    setToken(null);
    test.mutate();
  }

  return (
    <div className="flex flex-col gap-mx-lg">
      {(connection.kind === "model" || connection.existing?.configured) && (
        <Notice>
          {connection.kind === "broker"
            ? t(
                "已有密钥不会回填到表单。",
                "Saved keys are never filled back into the form.",
              )
            : t(
                "模型请求会发送到你选择的提供商。密钥保存在运行 Trading Max 的设备上，用于该提供商的请求。",
                "Model requests go to your selected provider. Your key is stored on the device running Trading Max and used for requests to that provider.",
              )}
        </Notice>
      )}
      <form
        method="post"
        autoComplete="off"
        noValidate
        aria-label={t("连接 ", "Connect ") + connection.title}
        onKeyDown={guardSettingsFormEnter}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (token && required.validate(e.currentTarget)) save.mutate();
          else if (!token) runTest(e.currentTarget);
        }}
      >
        <div className="flex flex-col gap-mx-md">
          {connection.kind === "broker" && (
            <SelectPicker
              data-autofocus
              label={t("账户环境", "Account environment")}
              value={environment}
              onChange={(v) => edit(() => setEnvironment(v ?? "live"))}
              options={[
                { value: "live", label: t("真实账户", "Live account") },
                { value: "demo", label: t("模拟账户", "Demo account") },
              ]}
              disabled={busy}
            />
          )}
          <CredentialField
            data-autofocus={connection.kind !== "broker" || undefined}
            label={connection.kind === "broker" ? "API Key ID" : "API Key"}
            name={keyFieldName}
            autoComplete="off"
            error={required.missing(apiKey, keyFieldName) ? keyMissingMsg : undefined}
            value={apiKey}
            onChange={(e) => {
              const value = e.currentTarget.value;
              edit(() => setApiKey(value), keyFieldName, value);
            }}
            onBlur={(e) => required.markBlurred(keyFieldName, e.currentTarget.value, keyMissingMsg, e)}
            revealLabel={t("显示或隐藏密钥", "Show or hide key")}
            disabled={busy}
          />
          {connection.kind === "broker" ? (
            <CredentialField
              label="API Secret"
              name={secretFieldName}
              autoComplete="off"
              error={required.missing(secretKey, secretFieldName) ? secretMissingMsg : undefined}
              value={secretKey}
              onChange={(e) => {
                const value = e.currentTarget.value;
                edit(() => setSecretKey(value), secretFieldName, value);
              }}
              onBlur={(e) =>
                required.markBlurred(secretFieldName, e.currentTarget.value, secretMissingMsg, e)
              }
              revealLabel={t("显示或隐藏 Secret", "Show or hide secret")}
              disabled={busy}
            />
          ) : (
            <SearchPicker
              label={t("测试模型", "Model to test")}
              value={model}
              onChange={(v) => edit(() => setModel(v ?? ""))}
              options={Array.from(new Set([model, ...connection.provider.models].filter(Boolean)))}
              disabled={busy}
            />
          )}
          {required.liveRegion}
          {connection.kind === "broker" && (
            <details className={settingsBrokerKeyHelpClass}>
              <summary>
                {t("如何创建只读 API 密钥？", "How do I create a read-only API key?")}
              </summary>
              <p>
                {t(
                  "在 Trading\u00a0212 的目标账户中，打开菜单 → 设置 → API\u00a0(Beta) → Generate\u00a0API\u00a0key，确认风险提示。",
                  "In the Trading\u00a0212 account you want to connect, open Menu → Settings → API\u00a0(Beta) → Generate\u00a0API\u00a0key and accept the risk warning.",
                )}
              </p>
              <p>
                {t(
                  "勾选 Account data、Portfolio 和 History（包括 Dividends、Orders、Transactions）。不要开启 Orders\u00a0-\u00a0Execute 或写入权限。",
                  "Select Account data, Portfolio and History (Dividends, Orders and Transactions). Leave Orders\u00a0-\u00a0Execute and write permissions off.",
                )}
              </p>
              <p>
                {t(
                  "Invest 和 Stocks\u00a0ISA 各用一组密钥。真实账户选「真实账户」，练习账户选「模拟账户」。Secret 只显示一次。",
                  "Create a separate key pair for Invest and Stocks\u00a0ISA. Match your broker mode: Live account for real money, Demo account for Practice. The secret is shown once.",
                )}
              </p>
              <a
                href="https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key"
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                {t("Trading\u00a0212 官方指南", "Trading\u00a0212 API key guide")}
              </a>
            </details>
          )}
          {connection.kind === "model" && (
            <Checkbox
              label={t("设为默认模型", "Use as the default model")}
              description={t(
                "用于未单独指定模型的代码识别。",
                "Used for ticker matching without a separate assignment.",
              )}
              checked={useAsDefault}
              onCheckedChange={(checked) => setUseAsDefault(checked)}
              disabled={busy}
            />
          )}
          {test.isError || test.data?.status === "failed" ? (
            <Notice tone="bad">
              {connection.kind === "broker" &&
              test.error instanceof ApiError &&
              test.error.code === "provider_auth_failed"
                ? t(
                    "密钥未被 Trading 212 接受。请检查 Key ID、Secret 和真实／模拟账户环境，再重新测试。",
                    "Trading 212 rejected the credentials. Check the Key ID, Secret, and Live/Demo environment, then test again.",
                  )
                : connection.kind === "broker" &&
                    test.error instanceof ApiError &&
                    test.error.code === "provider_permission_denied"
                  ? t(
                      "这组密钥缺少访问权限。请在 Trading 212 开启账户数据与历史记录的只读权限，再重新测试。",
                      "These credentials lack access. Enable read-only account data and history permissions in Trading 212, then test again.",
                    )
                  : test.error instanceof ApiError && test.error.code === "provider_rate_limited"
                    ? t(
                        "提供商暂时限制了请求频率。请稍等片刻再测试，无需重新输入密钥。",
                        "The provider is rate limiting requests. Wait a moment and test again; you do not need to re-enter the keys.",
                      )
                    : test.error instanceof ApiError && test.error.code === "provider_unavailable"
                      ? t(
                          "暂时无法连接提供商。请检查网络后重试；这不代表密钥有误。",
                          "The provider is temporarily unreachable. Check your connection and retry; this does not mean the keys are invalid.",
                        )
                      : t(
                          "连接测试未通过。请检查密钥、账户环境和访问权限后重试。",
                          "Connection test failed. Check the key, account environment, and permissions, then try again.",
                        )}
            </Notice>
          ) : (
            token && (
              <Notice tone="good">
                {connection.kind === "broker"
                  ? t(
                      "只读访问测试通过，可以保存凭据。",
                      "Read-only access verified. You can now save the credentials.",
                    )
                  : t(
                      "连接测试通过，可以安全保存。",
                      "Connection verified. You can now save it.",
                    )}
              </Notice>
            )
          )}
          {save.isError && (
            <Notice tone="bad">
              {t(
                "未能保存连接。请重新测试后再试一次。",
                "Connection could not be saved. Test again and retry.",
              )}
            </Notice>
          )}
          <div className="flex flex-col gap-mx-xs">
            <div className="flex flex-wrap items-center gap-mx-md">
              <Button
                className="grow max-w-[calc(50%-8px)]"
                type={token ? "button" : "submit"}
                variant="outline"
                onClick={
                  token
                    ? (event) => runTest((event.currentTarget as HTMLButtonElement).form)
                    : undefined
                }
                disabled={save.isPending || (connection.kind === "model" && !model)}
                loading={test.isPending}
                loadingLabel={t("测试中…", "Testing…")}
              >
                {t("测试连接", "Test connection")}
              </Button>
              <Button
                className="grow max-w-[calc(50%-8px)]"
                type={token ? "submit" : "button"}
                aria-describedby={!token ? "connection-save-requirement" : undefined}
                disabled={!token || test.isPending}
                loading={save.isPending}
                loadingLabel={t("保存中…", "Saving…")}
              >
                <CircleCheck size={18} aria-hidden="true" />
                {t("保存连接", "Save connection")}
              </Button>
            </div>
            {!token && (
              <p className="text-xs leading-[1.9] text-muted-foreground" id="connection-save-requirement">
                {t("连接测试通过后即可保存。", "Test the connection before saving.")}
              </p>
            )}
          </div>
        </div>
      </form>
      {connection.existing?.configured && (
        <div className={settingsDangerZoneClass}>
          <h3 className={settingsRowHeadingClass}>{t("断开此连接", "Disconnect this provider")}</h3>
          <p className={settingsRowCopyClass}>
            {t(
              "停止使用已保存的凭据。已生成的账户快照和研究记录会保留。",
              "Stop using the saved credentials. Existing account snapshots and research remain available.",
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="mt-3"
            onClick={() => setDisconnecting(true)}
          >
            {t("断开连接", "Disconnect")}
          </Button>
        </div>
      )}
      <WorkspaceAlertDialog
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        title={t("确认断开连接", "Confirm disconnection")}
      >
        <div className="flex flex-col gap-mx-md">
          <p className="text-[13px] leading-[1.8]">
            {t(
              "新的数据更新将不再使用此连接。之后可以重新输入凭据连接。",
              "New updates will no longer use this connection. You can reconnect by entering your credentials again.",
            )}
          </p>
          {disconnect.isError && (
            <Notice tone="bad">
              {t("未能断开连接，请重试。", "Could not disconnect. Please retry.")}
            </Notice>
          )}
          <div className="flex flex-wrap items-center justify-end gap-mx-md">
            <Button
              type="button"
              data-autofocus
              variant="secondary"
              onClick={() => setDisconnecting(false)}
            >
              {t("保留连接", "Keep connection")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => disconnect.mutate()}
              loading={disconnect.isPending}
              loadingLabel={t("断开中…", "Disconnecting…")}
            >
              {t("确认断开", "Disconnect")}
            </Button>
          </div>
        </div>
      </WorkspaceAlertDialog>
    </div>
  );
}

function providerAuthGroupLabel(
  provider: LLMProviderDescriptor,
  connected: boolean,
  t: (zh: string, en: string) => string,
) {
  const base =
    provider.authMethod === "oauth"
      ? provider.label.includes("ChatGPT")
        ? provider.label
        : `${provider.label} · ChatGPT`
      : `${provider.label} · API Key`;
  return connected ? base : `${base} · ${t("未连接", "Unavailable")}`;
}

function ModelRouting({
  policy,
  providers,
  integrations,
  onConnectProvider,
  refresh,
}: {
  policy: LLMRoutePolicy;
  providers: LLMProviderDescriptor[];
  integrations: IntegrationSummary[];
  onConnectProvider: (provider: LLMProviderDescriptor, trigger: HTMLButtonElement) => void;
  refresh: () => void;
}) {
  const t = useCopy();
  const client = useQueryClient();
  const { routing: draft, setRouting: setDraft } = useSettingsDrafts();
  const activeDraft = draft?.baseRevision === policy.revision ? draft : undefined;
  useEffect(() => {
    if (draft && draft.baseRevision < policy.revision) {
      setDraft((current) => current === draft ? undefined : current);
    }
  }, [draft, policy.revision, setDraft]);
  const defaultRoute = activeDraft?.defaultRoute ?? policy.defaultRoute;
  const overrides = activeDraft?.overrides ?? policy.overrides;
  const dirty =
    defaultRoute !== policy.defaultRoute || !sameStringRecord(overrides, policy.overrides);

  const connectedProviders = new Set<string>(
    integrations.filter((item) => isConnectedIntegration(item)).map((item) => item.provider),
  );
  const groupedOptions = providers.map((provider) => {
    const connected = connectedProviders.has(provider.provider);
    return {
      group: providerAuthGroupLabel(provider, connected, t),
      items: provider.models.map((model) => ({
        value: provider.provider + "/" + model,
        label: connected
          ? provider.label + " · " + model
          : provider.label + " · " + model + t("（未连接）", " (unavailable)"),
      })),
    };
  });
  const knownValues = new Set(groupedOptions.flatMap((g) => g.items.map((item) => item.value)));
  const extraItems: Array<{ value: string; label: string }> = [];
  for (const route of [
    policy.defaultRoute,
    defaultRoute,
    ...Object.values(policy.overrides),
    ...Object.values(overrides),
  ]) {
    if (!route || knownValues.has(route)) continue;
    knownValues.add(route);
    const providerKey = route.split("/")[0];
    const connected = connectedProviders.has(providerKey);
    extraItems.push({
      value: route,
      label: connected ? route : route + t("（未连接）", " (unavailable)"),
    });
  }
  const options = extraItems.length
    ? [
        ...groupedOptions,
        { group: t("已保存的路由", "Saved routes"), items: extraItems },
      ]
    : groupedOptions;

  const defaultProviderKey = defaultRoute.split("/")[0];
  const defaultRouteUnavailable = Boolean(defaultRoute && !connectedProviders.has(defaultProviderKey));
  const taxonomyProviderKey = overrides.taxonomy?.split("/")[0];
  const taxonomyOverrideUnavailable = Boolean(taxonomyProviderKey && !connectedProviders.has(taxonomyProviderKey));
  function reconnect(route: string) {
    const provider = providers.find((item) => item.provider === route.split("/")[0]);
    if (!provider) return null;
    return (
      <button
        type="button"
        className="mx-text-link self-start min-h-10 border-0 bg-transparent p-0 focus-visible:outline-offset-2 pointer-coarse:min-h-11"
        onClick={(event) => onConnectProvider(provider, event.currentTarget)}
      >
        {t("连接 ", "Connect ") + (provider.provider === "openai-codex" ? "OpenAI" : provider.label)}
      </button>
    );
  }

  const lenses = [{ value: "taxonomy", label: t("代码识别", "Ticker matching") }];
  const mutation = useMutation({
    mutationFn: (submitted: ModelRoutingSubmission) =>
      api<LLMRoutePolicy>("/settings/llm/routes", jsonRequest("PUT", submitted)),
    onSuccess: async (committed, submitted) => {
      await client.cancelQueries({ queryKey: settingsKey });
      setDraft((current) => reconcileModelRoutingDraft(current, submitted, committed));
      client.setQueryData<IntegrationOverview>(settingsKey, (overview) =>
        overview && (overview.llmRoutePolicy?.revision ?? 0) <= committed.revision
          ? { ...overview, llmRoutePolicy: committed }
          : overview,
      );
      refresh();
    },
  });
  const savedRevision =
    mutation.isSuccess &&
    mutation.data.revision === mutation.variables.expectedRevision + 1 &&
    mutation.data.revision === policy.revision;
  const saved = savedRevision && !dirty;

  return (
    <Panel
      title={t("模型分配", "Model assignments")}
      description={t(
        "默认模型与单独覆盖仅用于代码识别：把公司名、简称或描述匹配到代码。",
        "Default and override assignments apply to ticker matching: matching company names, aliases or descriptions to tickers.",
      )}
    >
      <form
        method="post"
        aria-label={t("模型分配", "Model assignments")}
        onKeyDown={guardSettingsFormEnter}
        onSubmit={(event) => {
          event.preventDefault();
          if (!mutation.isPending) {
            mutation.mutate({
              defaultRoute,
              overrides,
              expectedRevision: policy.revision,
            });
          }
        }}
      >
        <input type="hidden" name="defaultRoute" value={defaultRoute} />
        {lenses.map((lens) => (
          <input
            key={lens.value}
            type="hidden"
            name={`override-${lens.value}`}
            value={overrides[lens.value] ?? ""}
          />
        ))}
        <div className="flex flex-col gap-mx-lg">
          <div className="flex min-w-0 flex-col gap-2">
            <SearchPicker
              label={t("默认模型", "Default model")}
              options={options}
              value={defaultRoute}
              onChange={(value) => {
                const next = value ?? policy.defaultRoute;
                const changed = next !== policy.defaultRoute || mutation.isPending;
                setDraft(changed || activeDraft?.overrides ? {
                  ...activeDraft,
                  baseRevision: policy.revision,
                  defaultRoute: changed ? next : undefined,
                } : undefined);
              }}
            />
            {defaultRouteUnavailable && reconnect(defaultRoute)}
          </div>
          <details className="mx-details">
            <summary>{t("代码识别单独设置", "Override ticker matching model")}</summary>
            <div className={settingsFormGridClass}>
              {lenses.map((lens) => (
                <div key={lens.value} className="flex min-w-0 flex-col gap-2">
                  <SearchPicker
                    label={lens.label}
                    options={options}
                    placeholder={t("使用默认模型", "Use default model")}
                    value={overrides[lens.value] ?? null}
                    clearable
                    clearLabel={t("使用默认模型", "Use default model")}
                    onChange={(value) => {
                      const next = { ...overrides };
                      if (value) next[lens.value] = value;
                      else delete next[lens.value];
                      const changed = mutation.isPending || !sameStringRecord(next, policy.overrides);
                      setDraft(changed || activeDraft?.defaultRoute ? {
                        ...activeDraft,
                        baseRevision: policy.revision,
                        overrides: changed ? next : undefined,
                      } : undefined);
                    }}
                  />
                  {taxonomyOverrideUnavailable && reconnect(overrides[lens.value])}
                </div>
              ))}
            </div>
          </details>
          {mutation.isError && (
            <Notice tone="bad">
              {mutation.error instanceof ApiError && mutation.error.status === 409
                ? t(
                    "设置已在其他窗口更新。重新加载后再保存。",
                    "Settings changed in another window. Reload before saving.",
                  )
                : t(
                    "模型分配未保存。请检查所选模型和连接状态后重试。",
                    "Model assignments were not saved. Check the selected models and connections, then retry.",
                  )}
            </Notice>
          )}
          {saved && (
            <Notice tone="good">{t("模型分配已保存。", "Model assignments saved.")}</Notice>
          )}
          <div className="flex flex-wrap items-center gap-mx-md">
            <Button
              type="submit"
              loading={mutation.isPending}
              loadingLabel={t("保存中…", "Saving…")}
            >
              {t("保存模型分配", "Save model assignments")}
            </Button>
            {dirty && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() => {
                    setDraft(undefined);
                    mutation.reset();
                  }}
                >
                  {t("放弃修改", "Discard changes")}
                </Button>
                <span role="status" className="text-xs text-muted-foreground">
                  {t("还有未保存的修改", "You have unsaved changes")}
                </span>
              </>
            )}
          </div>
        </div>
      </form>
    </Panel>
  );
}
