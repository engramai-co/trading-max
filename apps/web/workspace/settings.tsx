"use client";

import {
  Button,
  Checkbox,
  Drawer,
  Group,
  Modal,
  PasswordInput,
  Select,
  SegmentedControl,
  Stack,
} from "@mantine/core";
import {
  ArrowRight,
  CheckCircle,
  LinkSimple,
  Plug,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
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
  Pending,
  QueryError,
  Tabs,
  Tag,
  useCopy,
} from "./foundation";
import { useRouteState } from "./route-state";
import {
  AutomationPreferences,
  CfdImports,
  PersonalPreferences,
} from "./settings-preferences";

import { OpenAIOAuthConnection } from "./settings-oauth";

import { ReconstructionMarketData } from "./settings-market-data";

import { LocalOnboarding } from "./local-onboarding";

const settingsKey = ["workspace-settings"];
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

export function SettingsWorkspace({ localWorkspace = false }: { localWorkspace?: boolean }) {
  const t = useCopy();
  const { params, update } = useRouteState();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: settingsKey,
    queryFn: () => api<IntegrationOverview>("/settings/integrations"),
    retry: 1,
  });
  const [connection, setConnection] = useState<Connection | null>(null);
  const [saved, setSaved] = useState<"saved" | "disconnected" | null>(null);
  const [offerModelConnection, setOfferModelConnection] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const tabs = [
    { value: "accounts", label: t("账户与数据", "Accounts & data") },
    { value: "models", label: t("模型连接", "Model connections") },
    { value: "automation", label: t("更新计划", "Update schedule") },
    { value: "preferences", label: t("个人偏好", "Preferences") },
  ];
  const view = tabs.some((tab) => tab.value === params.get("tab"))
    ? params.get("tab")!
    : "accounts";
  const data = query.data;
  const hasModelConnection = data?.llmProviders.some((provider) =>
    data.integrations.some((item) => item.provider === provider.provider &&
      item.configured && item.enabled && !item.needsSecret),
  );
  const visibleProviders = data?.llmProviders.filter((provider) => provider.provider !== "openai-codex") ?? [];
  function openModel(provider: LLMProviderDescriptor, first = false) {
    const existingApi = data?.integrations.some((item) => item.provider === "openai" && item.configured && item.enabled);
    const existingOAuth = data?.integrations.some((item) => item.provider === "openai-codex" && item.configured && item.enabled);
    const chosen = provider.provider === "openai" && (!existingApi || existingOAuth)
      ? data?.llmProviders.find((item) => item.provider === "openai-codex") ?? provider : provider;
    setSaved(null);
    setConnection({ kind: "model", title: provider.label, provider: chosen,
      existing: data?.integrations.find((item) => item.provider === chosen.provider),
      useAsDefault: first || !hasModelConnection || data?.llmRoutePolicy?.defaultRoute.startsWith(chosen.provider + "/"),
    });
  }
  return (
    <Page
      title={t("设置与连接", "Settings & connections")}
      actions={
        <Button
          component={Link}
          href="/health"
          variant="default"
          rightSection={<ArrowRight size={16} />}
        >
          {t("查看数据状态", "Data status")}
        </Button>
      }
    >
      <Tabs
        label={t("设置分类", "Settings sections")}
        value={view}
        onChange={(value) => update({ tab: value })}
        options={tabs}
      />
      {saved && (
        <Notice tone="good">
          {saved === "disconnected"
            ? t(
                "连接已断开。已保存的快照仍可查看。",
                "Connection removed. Saved snapshots remain available.",
              )
            : t(
                "连接已保存。下一次更新将使用新的设置。",
                "Connection saved. Your next update will use these settings.",
              )}
        </Notice>
      )}
      {query.isPending ? (
        <Pending />
      ) : query.isError || !data ? (
        <QueryError retry={query.refetch} />
      ) : (
        <>
          {view === "accounts" && (
            <>
              {localWorkspace && <LocalOnboarding />}
              <Panel
                title={t("Trading 212 账户", "Trading 212 accounts")}
              >
                <div className="mx-connection-grid">
                  {(["invest", "isa"] as const).map((profile) => {
                    const existing = data.integrations.find(
                      (i) =>
                        i.provider === "trading212" && i.profile === profile,
                    );
                    return (
                      <ConnectionCard
                        key={profile}
                        title={
                          profile === "invest"
                            ? "Invest"
                            : "Stocks & Shares ISA"
                        }
                        integration={existing}
                        onOpen={() => {
                          setSaved(null);
                          setConnection({
                            kind: "broker",
                            profile,
                            title: profile === "invest" ? "Invest" : "ISA",
                            existing,
                          });
                        }}
                      />
                    );
                  })}
                </div>
              </Panel>
              {params.get("onboarding") !== "1" && <>
              <Panel
                title={t("公开市场数据", "Public market research")}
              >
                <div className="mx-setting-row">
                  <div>
                    <h3>
                      {t(
                        "Yahoo Finance 兼容数据源",
                        "Yahoo Finance-compatible source",
                      )}
                    </h3>
                    <p>
                      {t(
                        "无需 API 密钥",
                        "No API key required",
                      )}
                    </p>
                  </div>
                  <Button
                    component={Link}
                    href="/research"
                    variant="subtle"
                    rightSection={<ArrowRight size={16} />}
                  >
                    {t("前往研究", "Open research")}
                  </Button>
                </div>
              </Panel>
              <ReconstructionMarketData integration={data.integrations.find((item) => item.provider === "alpaca")} onSaved={() => { void client.invalidateQueries({ queryKey: settingsKey }); }} />
              <CfdImports />
              </>}
            </>
          )}
          {view === "models" && (
            <>
              <Panel
                title={t("模型连接（可选）", "Model connections (optional)")}
              >
                <div className="mx-connection-grid mx-model-connections">
                  {visibleProviders.map((provider) => (
                    <ConnectionCard
                      key={provider.provider}
                      title={provider.label}
                      connectLabel={t("连接模型", "Connect model")}
                      subtitle={provider.defaultModel}
                      integration={(provider.provider === "openai" ? data.integrations.find((i) => i.provider === "openai-codex" && i.configured && i.enabled) : undefined) ??
                        data.integrations.find((i) => i.provider === provider.provider)}
                      onOpen={() => openModel(provider)}
                    />
                  ))}
                </div>
                {!data.llmProviders.length && (
                  <Empty
                    title={t(
                      "暂无可用模型提供商",
                      "No model providers available",
                    )}
                  />
                )}
              </Panel>
              {data.llmRoutePolicy && (
                <ModelRouting
                  key={data.llmRoutePolicy.revision}
                  policy={data.llmRoutePolicy}
                  providers={data.llmProviders}
                  refresh={() => void query.refetch()}
                />
              )}
            </>
          )}
          {view === "automation" && <AutomationPreferences />}
          {view === "preferences" && (
            <PersonalPreferences
              profile={data.profile}
              refresh={() => void query.refetch()}
            />
          )}
        </>
      )}
      <Modal
        opened={view === "models" && Boolean(data?.llmProviders.length) &&
          !hasModelConnection && offerModelConnection && !connection}
        onClose={() => setOfferModelConnection(false)}
        title={t("连接你的模型", "Connect your model")}
        centered
      >
        <Stack gap="lg">
          <p>{t(
            "选择你想使用的提供商。OpenAI 支持 ChatGPT 登录或 API Key；你也可以稍后再设置。",
            "Choose a provider. OpenAI supports ChatGPT sign-in or an API key. You can also set this up later.",
          )}</p>
          <Select
            label={t("模型提供商", "Model provider")}
            value={selectedProvider}
            onChange={(value) => setSelectedProvider(value ?? "openai")}
            data={visibleProviders.map((provider) => ({
              value: provider.provider, label: provider.label,
            })) ?? []}
            allowDeselect={false}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setOfferModelConnection(false)}>
              {t("稍后设置", "Set up later")}
            </Button>
            <Button onClick={() => {
              const provider = data?.llmProviders.find((item) => item.provider === selectedProvider);
              if (!provider) return;
              setOfferModelConnection(false);
              openModel(provider, true);
            }} rightSection={<ArrowRight size={16} />}>
              {t("继续连接", "Continue")}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Drawer
        opened={connection !== null}
        onClose={() => setConnection(null)}
        title={connection ? t("连接 ", "Connect ") + connection.title : ""}
        position="right"
        size={480}
      >
        {connection && <Stack gap="lg">
          {connection.kind === "model" && ["openai", "openai-codex"].includes(connection.provider.provider) &&
            <SegmentedControl fullWidth aria-label={t("OpenAI 连接方式", "OpenAI connection method")}
              value={connection.provider.provider}
              data={[{ value: "openai-codex", label: t("ChatGPT 登录", "ChatGPT sign-in") }, { value: "openai", label: "API Key" }]}
              onChange={(value) => {
                const provider = data?.llmProviders.find((item) => item.provider === value);
                if (provider) setConnection({ ...connection, provider,
                  existing: data?.integrations.find((item) => item.provider === value) });
              }} />}
          {connection.kind === "model" && connection.provider.authMethod === "oauth"
            ? <OpenAIOAuthConnection provider={connection.provider} existing={connection.existing}
                useAsDefault={connection.useAsDefault} onSaved={(result) => {
                  setConnection(null); setSaved(result);
                  void client.invalidateQueries({ queryKey: settingsKey });
                }} />
            : <ConnectionForm key={connection.kind === "broker" ? connection.profile : connection.provider.provider}
                connection={connection} onSaved={(result) => {
                  setConnection(null); setSaved(result);
                  void client.invalidateQueries({ queryKey: settingsKey });
                }} />}
        </Stack>}
      </Drawer>
    </Page>
  );
}

function ConnectionCard({
  title,
  subtitle,
  integration,
  onOpen,
  connectLabel,
}: {
  title: string;
  subtitle?: string;
  integration?: IntegrationSummary;
  onOpen: () => void;
  connectLabel?: string;
}) {
  const t = useCopy();
  const connected =
    integration?.configured && integration.enabled && !integration.needsSecret;
  return (
    <div className="mx-connection-card">
      <div className="mx-toolbar">
        <span className="mx-connection-icon">
          <Plug size={24} />
        </span>
        <Tag
          tone={
            connected
              ? "good"
              : integration?.lastTestStatus === "failed"
                ? "warn"
                : "neutral"
          }
        >
          {connected
            ? t("已连接", "Connected")
            : integration?.needsSecret && integration.configured
              ? t("需要重新连接", "Reconnect needed")
              : t("未连接", "Not connected")}
        </Tag>
      </div>
      <h3>{title}</h3>
      {subtitle && <p>{subtitle}</p>}
      {integration?.lastTestAt && (
        <Freshness
          date={integration.lastTestAt}
          label={t("上次测试", "Last tested")}
        />
      )}
      <Button
        variant={connected ? "default" : "filled"}
        leftSection={<LinkSimple size={16} />}
        onClick={onOpen}
      >
        {connected
          ? t("管理连接", "Manage connection")
          : (connectLabel ?? t("连接账户", "Connect"))}
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
      ? { apiKeyId: apiKey, secretKey, environment }
      : { apiKey, model };
  const test = useMutation({
    mutationFn: () =>
      api<TestResult>(path + "/test", jsonRequest("POST", payload)),
    onSuccess: (result) =>
      setToken(result.status === "succeeded" ? result.validationToken : null),
  });
  const save = useMutation({
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
  function edit(update: () => void) {
    update();
    setToken(null);
    test.reset();
    save.reset();
  }
  const ready =
    apiKey.trim().length > 0 &&
    (connection.kind === "broker"
      ? secretKey.trim().length > 0
      : model.length > 0);
  return (
    <Stack gap="lg">
      <Notice>
        {connection.kind === "broker"
          ? t(
              "请使用该账户的只读 API 凭据。已有密钥不会回填到表单。",
              "Use this account’s read-only API credentials. Saved keys are never filled back into the form.",
            )
          : t(
              "证券识别请求会发送到你选择的提供商。密钥保存在运行 Trading Max 的设备上，用于该提供商的请求。",
              "Analysis requests go to your selected provider. Your key is stored on the device running Trading Max and used for requests to that provider.",
            )}
      </Notice>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (token) save.mutate();
          else if (ready) test.mutate();
        }}
      >
        <Stack gap="md">
          {connection.kind === "broker" && (
            <Select
              label={t("账户环境", "Account environment")}
              value={environment}
              onChange={(v) => edit(() => setEnvironment(v ?? "live"))}
              data={[
                { value: "live", label: t("真实账户", "Live account") },
                { value: "demo", label: t("模拟账户", "Demo account") },
              ]}
              disabled={busy}
            />
          )}
          <PasswordInput
            label={connection.kind === "broker" ? "API Key ID" : "API Key"}
            value={apiKey}
            onChange={(e) => {
              const value = e.currentTarget.value;
              edit(() => setApiKey(value));
            }}
            visibilityToggleButtonProps={{
              "aria-label": t("显示或隐藏密钥", "Show or hide key"),
            }}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
          />
          {connection.kind === "broker" ? (
            <PasswordInput
              label="API Secret"
              value={secretKey}
              onChange={(e) => {
                const value = e.currentTarget.value;
                edit(() => setSecretKey(value));
              }}
              visibilityToggleButtonProps={{
                "aria-label": t("显示或隐藏 Secret", "Show or hide secret"),
              }}
              autoComplete="new-password"
              spellCheck={false}
              required
              disabled={busy}
            />
          ) : (
            <Select
              label={t("测试模型", "Model to test")}
              value={model}
              onChange={(v) => edit(() => setModel(v ?? ""))}
              data={Array.from(new Set([model, ...connection.provider.models].filter(Boolean)))}
              searchable
              disabled={busy}
            />
          )}
          {connection.kind === "model" && (
            <Checkbox
              label={t("设为默认模型", "Use as the default model")}
              description={t("用于未单独指定模型的证券名称识别。", "Used for security name resolution without a separate assignment.")}
              checked={useAsDefault}
              onChange={(event) => setUseAsDefault(event.currentTarget.checked)}
              disabled={busy}
            />
          )}
          {test.isError || test.data?.status === "failed" ? (
            <Notice tone="bad">
              {connection.kind === "broker" && test.error instanceof ApiError && test.error.code === "provider_auth_failed" ? t(
                "密钥未被 Trading 212 接受。请检查 Key ID、Secret 和真实／模拟账户环境，再重新测试。",
                "Trading 212 rejected the credentials. Check the Key ID, Secret, and Live/Demo environment, then test again.",
              ) : connection.kind === "broker" && test.error instanceof ApiError && test.error.code === "provider_permission_denied" ? t(
                "这组密钥缺少访问权限。请在 Trading 212 开启账户数据与历史记录的只读权限，再重新测试。",
                "These credentials lack access. Enable read-only account data and history permissions in Trading 212, then test again.",
              ) : test.error instanceof ApiError && test.error.code === "provider_rate_limited" ? t(
                "提供商暂时限制了请求频率。请稍等片刻再测试，无需重新输入密钥。",
                "The provider is rate limiting requests. Wait a moment and test again; you do not need to re-enter the keys.",
              ) : test.error instanceof ApiError && test.error.code === "provider_unavailable" ? t(
                "暂时无法连接提供商。请检查网络后重试；这不代表密钥有误。",
                "The provider is temporarily unreachable. Check your connection and retry; this does not mean the keys are invalid.",
              ) : t(
                "连接测试未通过。请检查密钥、账户环境和访问权限后重试。",
                "Connection test failed. Check the key, account environment, and permissions, then try again.",
              )}
            </Notice>
          ) : (
            token && (
              <Notice tone="good">
                {t(
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
          <Group grow>
            <Button
              variant="default"
              onClick={() => {
                setToken(null);
                test.mutate();
              }}
              disabled={!ready || save.isPending}
              loading={test.isPending}
            >
              {t("测试连接", "Test connection")}
            </Button>
            <Button
              type="submit"
              disabled={!token || test.isPending}
              loading={save.isPending}
              leftSection={<CheckCircle size={17} />}
            >
              {t("保存连接", "Save connection")}
            </Button>
          </Group>
        </Stack>
      </form>
      {connection.existing?.configured && (
        <div className="mx-danger-zone">
          <h3>{t("断开此连接", "Disconnect this provider")}</h3>
          <p>
            {t(
              "停止使用已保存的凭据。已生成的账户快照和研究记录会保留。",
              "Stop using the saved credentials. Existing account snapshots and research remain available.",
            )}
          </p>
          <Button
            color="red"
            variant="light"
            onClick={() => setDisconnecting(true)}
          >
            {t("断开连接", "Disconnect")}
          </Button>
        </div>
      )}
      <Modal
        opened={disconnecting}
        onClose={() => setDisconnecting(false)}
        title={t("确认断开连接", "Confirm disconnection")}
        centered
      >
        <Stack>
          <p className="mx-body-copy">
            {t(
              "新的数据更新将不再使用此连接。之后可以重新输入凭据连接。",
              "New updates will no longer use this connection. You can reconnect by entering your credentials again.",
            )}
          </p>
          {disconnect.isError && (
            <Notice tone="bad">
              {t(
                "未能断开连接，请重试。",
                "Could not disconnect. Please retry.",
              )}
            </Notice>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDisconnecting(false)}>
              {t("保留连接", "Keep connection")}
            </Button>
            <Button
              color="red"
              onClick={() => disconnect.mutate()}
              loading={disconnect.isPending}
            >
              {t("确认断开", "Disconnect")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function ModelRouting({
  policy,
  providers,
  refresh,
}: {
  policy: LLMRoutePolicy;
  providers: LLMProviderDescriptor[];
  refresh: () => void;
}) {
  const t = useCopy();
  const [defaultRoute, setDefaultRoute] = useState(policy.defaultRoute);
  const [overrides, setOverrides] = useState(policy.overrides);

  const options = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: provider.provider + "/" + model,
      label: provider.label + " · " + model,
    })),
  );
  for (const route of [policy.defaultRoute, ...Object.values(policy.overrides)]) {
    if (!options.some((o) => o.value === route)) options.push({ value: route, label: route });
  }
  const lenses = [
    { value: "taxonomy", label: t("证券名称识别", "Security name resolution") },
  ];
  const mutation = useMutation({
    mutationFn: (submitted: { defaultRoute: string; overrides: typeof overrides; expectedRevision: number }) =>
      api("/settings/llm/routes", jsonRequest("PUT", submitted)),
    onSuccess: () => refresh(),
  });
  const saved = mutation.isSuccess &&
    mutation.variables.defaultRoute === defaultRoute &&
    JSON.stringify(mutation.variables.overrides) === JSON.stringify(overrides);
  return (
    <Panel
      title={t("模型分配", "Model assignments")}
      description={t(
        "模型用于将公司名、简称或描述识别为证券候选。",
        "Models resolve company names, aliases, or descriptions into security candidates.",
      )}
    >
      <Stack gap="lg">
        <Select
          label={t("默认模型", "Default model")}
          data={options}
          value={defaultRoute}
          onChange={(v) => {
            setDefaultRoute(v ?? policy.defaultRoute);
          }}
          searchable
        />
        <details className="mx-details">
          <summary>
            {t("证券识别单独设置", "Override security resolution model")}
          </summary>
          <div className="mx-form-grid">
            {lenses.map((lens) => (
              <Select
                key={lens.value}
                label={lens.label}
                data={options}
                placeholder={t("使用默认模型", "Use default model")}
                value={overrides[lens.value] ?? null}
                clearable
                clearButtonProps={{
                  "aria-label": t("使用默认模型", "Use default model"),
                }}
                searchable
                onChange={(value) => {
                  setOverrides((current) => {
                    const next = { ...current };
                    if (value) next[lens.value] = value;
                    else delete next[lens.value];
                    return next;
                  });
                }}
              />
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
          <Notice tone="good">
            {t("模型分配已保存。", "Model assignments saved.")}
          </Notice>
        )}
        <Group>
          <Button
            loading={mutation.isPending}
            onClick={() => mutation.mutate({ defaultRoute, overrides: { ...overrides }, expectedRevision: policy.revision })}
          >
            {t("保存模型分配", "Save model assignments")}
          </Button>
          {mutation.isSuccess && !saved && (
            <span role="status">{t("还有未保存的修改", "You have unsaved changes")}</span>
          )}
        </Group>
      </Stack>
    </Panel>
  );
}
