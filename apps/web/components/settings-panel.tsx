"use client";

import {
  Alert,
  Accordion,
  Badge,
  Button,
  Card,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  CheckCircle as CheckCircleIcon,
  ArrowClockwise,
  ClockCountdown,
  FileCsv,
  Key,
  LockKey,
  Plug,
  Sparkle,
  Trash,
  UploadSimple,
  Warning,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useLocale, useMessages } from "@/components/locale-provider";
import { ContextHelp } from "@/components/context-help";
import type {
  AutomationSettings,
  CfdImportStatus,
  IntegrationOverview,
  IntegrationSummary,
  LLMProvider,
  LLMProviderDescriptor,
} from "@/lib/types";
import {
  formatDate,
  formatDateTime,
  formatScheduleTimes,
  formatTimeZoneLabel,
} from "@/ui/formatters";

type Props = {
  initial: IntegrationOverview | null;
  initialAutomation: AutomationSettings | null;
  initialCfdStatus: CfdImportStatus | null;
  initialError: string | null;
};
type Account = "invest" | "isa";
type BusyKey =
  | Account
  | LLMProvider
  | "routePolicy"
  | "automation"
  | "cfdImport"
  | "cfdPreference"
  | "cfdRefresh";
type BusyState = Partial<Record<BusyKey, boolean>>;
type TestState = {
  status: "idle" | "passed" | "failed";
  validationToken: string | null;
};
type TestResult = { validationToken?: string; message?: string };
type RoutePolicyDraft = {
  defaultRoute: string;
  overrides: { portfolio: string; ticker: string; taxonomy: string };
  revision: number;
};
type RouteOption = { value: string; label: string };
type AutomationDraft = {
  liveEnabled: boolean;
  performanceEnabled: boolean;
  researchEnabled: boolean;
};
type CfdUpload = {
  file: File;
  status: "selected" | "uploading" | "imported" | "duplicate" | "failed";
  detail?: string;
};

const DEFAULT_LLM_PROVIDERS: LLMProviderDescriptor[] = [
  {
    provider: "opencode",
    label: "OpenCode",
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-v4-flash",
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    adapter: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
    defaultModel: "deepseek-v4-flash",
  },
];

function formatModelLabel(model: string) {
  return model
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "deepseek") return "DeepSeek";
      if (/^v\d+$/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function integration(
  overview: IntegrationOverview | null,
  provider: IntegrationSummary["provider"],
  profile: string | null = null,
) {
  return overview?.integrations.find(
    (item) => item.provider === provider && item.profile === profile,
  );
}

async function readError(response: Response) {
  try {
    const payload = (await response.json()) as { detail?: string | { message?: string } };
    if (typeof payload.detail === "string") return payload.detail;
    return payload.detail?.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function SecretInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { locale } = useLocale();
  return <PasswordInput
    autoComplete="new-password"
    id={id}
    label={label}
    name={id}
    onChange={(event) => onChange(event.currentTarget.value)}
    spellCheck={false}
    value={value}
    visibilityToggleButtonProps={{
      "aria-label": locale === "zh" ? `显示或隐藏${label}` : `Show or hide ${label}`,
    }}
    visibilityToggleFocusable
  />;
}

function TestBadge({ state }: { state: TestState }) {
  const messages = useMessages();
  if (state.status === "idle") return null;
  return <Badge aria-live="polite" color={state.status === "passed" ? "green" : "red"} role="status">
    {state.status === "passed" ? messages.settings.testPassed : messages.settings.testFailed}
  </Badge>;
}

const idleTest = (): TestState => ({ status: "idle", validationToken: null });

export function SettingsPanel({
  initial,
  initialAutomation,
  initialCfdStatus,
  initialError,
}: Props) {
  const messages = useMessages();
  const { locale, timeZone } = useLocale();
  const router = useRouter();
  const overview = initial;
  const [busy, setBusy] = useState<BusyState>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [trading212, setTrading212] = useState({
    invest: { apiKeyId: "", secretKey: "" },
    isa: { apiKeyId: "", secretKey: "" },
  });
  const [tradingTests, setTradingTests] = useState<Record<Account, TestState>>({
    invest: idleTest(),
    isa: idleTest(),
  });
  const llmProviders = (initial?.llmProviders?.length
    ? initial.llmProviders
    : DEFAULT_LLM_PROVIDERS) as LLMProviderDescriptor[];
  const providerDescriptor = (provider: LLMProvider) =>
    llmProviders.find((item) => item.provider === provider) ??
    DEFAULT_LLM_PROVIDERS.find((item) => item.provider === provider)!;
  const savedLlm = (provider: LLMProvider) => integration(initial, provider);
  const [llm, setLlm] = useState<Record<LLMProvider, { apiKey: string; model: string }>>(
    () => ({
      opencode: {
        apiKey: "",
        model:
          savedLlm("opencode")?.model ?? providerDescriptor("opencode").defaultModel,
      },
      deepseek: {
        apiKey: "",
        model:
          savedLlm("deepseek")?.model ?? providerDescriptor("deepseek").defaultModel,
      },
    }),
  );
  const [llmTests, setLlmTests] = useState<Record<LLMProvider, TestState>>({
    opencode: idleTest(),
    deepseek: idleTest(),
  });
  const routeOptions: RouteOption[] = llmProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.provider}/${model}`,
      label: `${provider.label} · ${formatModelLabel(model)}`,
    })),
  );
  const initialRoutePolicy = initial?.llmRoutePolicy ?? {
    defaultRoute: routeOptions[0]?.value ?? "opencode/deepseek-v4-flash",
    overrides: {},
    revision: 1,
    updatedAt: "",
  };
  const [routePolicy, setRoutePolicy] = useState({
    defaultRoute: initialRoutePolicy.defaultRoute,
    overrides: {
      portfolio: initialRoutePolicy.overrides.portfolio ?? "",
      ticker: initialRoutePolicy.overrides.ticker ?? "",
      taxonomy: initialRoutePolicy.overrides.taxonomy ?? "",
    },
    revision: initialRoutePolicy.revision,
  });
  const [cfdStatus, setCfdStatus] = useState<CfdImportStatus | null>(initialCfdStatus);
  const [cfdUploads, setCfdUploads] = useState<CfdUpload[]>([]);
  const [cfdRetired, setCfdRetired] = useState(
    initialCfdStatus?.accountStatus === "retired",
  );
  const [automation, setAutomation] = useState<AutomationSettings | null>(initialAutomation);
  const [automationDraft, setAutomationDraft] = useState<AutomationDraft | null>(
    initialAutomation
      ? {
          liveEnabled: initialAutomation.liveEnabled ?? initialAutomation.intradayEnabled,
          performanceEnabled:
            initialAutomation.performanceEnabled ?? initialAutomation.nightlyEnabled,
          researchEnabled: initialAutomation.researchEnabled ?? initialAutomation.nightlyEnabled,
        }
      : null,
  );
  const configuredLlmCount = (["opencode", "deepseek"] as const).filter(
    (provider) => integration(overview, provider)?.configured,
  ).length;
  const hasUnsavedChanges =
    Boolean(
      trading212.invest.apiKeyId ||
        trading212.invest.secretKey ||
        trading212.isa.apiKeyId ||
        trading212.isa.secretKey ||
        llm.opencode.apiKey ||
        llm.deepseek.apiKey,
    ) ||
    ((Object.keys(llm) as LLMProvider[]).some(
        (provider) =>
          llm[provider].model !==
          (savedLlm(provider)?.model ?? providerDescriptor(provider).defaultModel),
      ) ||
        routePolicy.defaultRoute !== initialRoutePolicy.defaultRoute ||
        Object.entries(routePolicy.overrides).some(
          ([workload, value]) => value !== (initialRoutePolicy.overrides[workload] ?? ""),
        )) ||
    Boolean(
      automation &&
        automationDraft &&
        ((automation.liveEnabled ?? automation.intradayEnabled) !== automationDraft.liveEnabled ||
          (automation.performanceEnabled ?? automation.nightlyEnabled) !== automationDraft.performanceEnabled ||
          (automation.researchEnabled ?? automation.nightlyEnabled) !== automationDraft.researchEnabled),
    ) ||
    Boolean(cfdStatus && cfdRetired !== (cfdStatus.accountStatus === "retired"));

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const guardLinks = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.href === window.location.href) {
        return;
      }
      const proceed = window.confirm(
        locale === "zh"
          ? "还有未保存的设置。确定离开吗？"
          : "You have unsaved settings. Leave this page?",
      );
      if (!proceed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLinks, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [hasUnsavedChanges, locale]);

  const isBusy = (key: BusyKey) => Boolean(busy[key]);

  async function run(key: BusyKey, action: () => Promise<void>) {
    setBusy((current) => ({ ...current, [key]: true }));
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.settings.operationFailed);
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }

  function updateTrading212(account: Account, field: "apiKeyId" | "secretKey", value: string) {
    setTrading212((current) => ({
      ...current,
      [account]: { ...current[account], [field]: value },
    }));
    setTradingTests((current) => ({ ...current, [account]: idleTest() }));
  }

  async function testTrading212(account: Account) {
    await run(account, async () => {
      const values = trading212[account];
      const response = await fetch(
        `/api/backend/settings/integrations/trading212/${account}/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, environment: "live" }),
        },
      );
      if (!response.ok) {
        setTradingTests((current) => ({
          ...current,
          [account]: { status: "failed", validationToken: null },
        }));
        throw new Error(await readError(response));
      }
      const result = (await response.json()) as TestResult;
      if (!result.validationToken) throw new Error(messages.settings.operationFailed);
      setTradingTests((current) => ({
        ...current,
        [account]: { status: "passed", validationToken: result.validationToken ?? null },
      }));
      setMessage(messages.settings.testPassedDetail);
    });
  }

  async function saveTrading212(account: Account) {
    const validationToken = tradingTests[account].validationToken;
    if (!validationToken) return;
    await run(account, async () => {
      const response = await fetch(`/api/backend/settings/integrations/trading212/${account}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...trading212[account],
          validationToken,
          enabled: true,
          environment: "live",
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setTrading212((current) => ({
        ...current,
        [account]: { apiKeyId: "", secretKey: "" },
      }));
      setTradingTests((current) => ({ ...current, [account]: idleTest() }));
      setMessage(messages.settings.configured);
      router.refresh();
    });
  }

  async function disconnectTrading212(account: Account) {
    if (
      !window.confirm(
        locale === "zh"
          ? `确认断开 Trading 212 ${account === "invest" ? "Invest" : "ISA"}？已保存的凭据将被删除。`
          : `Disconnect Trading 212 ${account}? The stored credential will be deleted.`,
      )
    ) return;
    await run(account, async () => {
      const response = await fetch(`/api/backend/settings/integrations/trading212/${account}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage(messages.settings.disconnect);
      router.refresh();
    });
  }

  function updateLlm(provider: LLMProvider, field: "apiKey" | "model", value: string) {
    setLlm((current) => ({
      ...current,
      [provider]: { ...current[provider], [field]: value },
    }));
    setLlmTests((current) => ({ ...current, [provider]: idleTest() }));
  }

  async function testLlm(provider: LLMProvider) {
    await run(provider, async () => {
      const response = await fetch(`/api/backend/settings/llm/providers/${provider}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(llm[provider]),
      });
      if (!response.ok) {
        setLlmTests((current) => ({
          ...current,
          [provider]: { status: "failed", validationToken: null },
        }));
        throw new Error(await readError(response));
      }
      const result = (await response.json()) as TestResult;
      if (!result.validationToken) throw new Error(messages.settings.operationFailed);
      setLlmTests((current) => ({
        ...current,
        [provider]: { status: "passed", validationToken: result.validationToken ?? null },
      }));
      setMessage(messages.settings.testPassedDetail);
    });
  }

  async function saveLlm(provider: LLMProvider) {
    const validationToken = llmTests[provider].validationToken;
    if (!validationToken) return;
    await run(provider, async () => {
      const response = await fetch(`/api/backend/settings/llm/providers/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...llm[provider],
          validationToken,
          enabled: true,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setLlm((current) => ({
        ...current,
        [provider]: { ...current[provider], apiKey: "" },
      }));
      setLlmTests((current) => ({ ...current, [provider]: idleTest() }));
      setMessage(messages.settings.configured);
      router.refresh();
    });
  }

  async function disconnectLlm(provider: LLMProvider) {
    const label = providerDescriptor(provider).label;
    if (
      !window.confirm(
        locale === "zh"
          ? `确认断开 ${label}？已保存的 API key 将被删除。`
          : `Disconnect ${label}? The stored API key will be deleted.`,
      )
    ) return;
    await run(provider, async () => {
      const response = await fetch(`/api/backend/settings/llm/providers/${provider}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage(messages.settings.disconnect);
      router.refresh();
    });
  }

  function updateRoutePolicy(
    field: "defaultRoute" | "portfolio" | "ticker" | "taxonomy",
    value: string,
  ) {
    if (field === "defaultRoute") {
      setRoutePolicy((current) => ({ ...current, defaultRoute: value }));
      return;
    }
    setRoutePolicy((current) => ({
      ...current,
      overrides: { ...current.overrides, [field]: value },
    }));
  }

  async function saveRoutePolicy() {
    await run("routePolicy", async () => {
      const response = await fetch("/api/backend/settings/llm/route-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultRoute: routePolicy.defaultRoute,
          overrides: Object.fromEntries(
            Object.entries(routePolicy.overrides).filter(([, value]) => value),
          ),
          expectedRevision: routePolicy.revision,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const saved = (await response.json()) as {
        defaultRoute: string;
        overrides: Record<string, string>;
        revision: number;
      };
      setRoutePolicy({
        defaultRoute: saved.defaultRoute,
        overrides: {
          portfolio: saved.overrides.portfolio ?? "",
          ticker: saved.overrides.ticker ?? "",
          taxonomy: saved.overrides.taxonomy ?? "",
        },
        revision: saved.revision,
      });
      setMessage(locale === "zh" ? "路由策略已保存。" : "Routing policy saved.");
      router.refresh();
    });
  }

  function selectCfdFiles(files: FileList | null) {
    if (!files) return;
    setCfdUploads(
      Array.from(files).map((file) => ({
        file,
        status: "selected",
      })),
    );
  }

  async function uploadCfdFiles() {
    await run("cfdImport", async () => {
      let latestStatus = cfdStatus;
      for (let index = 0; index < cfdUploads.length; index += 1) {
        const upload = cfdUploads[index];
        if (upload.status === "imported" || upload.status === "duplicate") continue;
        setCfdUploads((current) => current.map((item, itemIndex) =>
          itemIndex === index ? { ...item, status: "uploading", detail: undefined } : item
        ));
        try {
          const response = await fetch("/api/backend/imports/trading212/cfd", {
            method: "POST",
            headers: {
              "Content-Type": "text/csv",
              "X-Trading-Max-Filename": upload.file.name,
            },
            body: upload.file,
          });
          if (!response.ok) throw new Error(await readError(response));
          const result = (await response.json()) as {
            status: "imported" | "duplicate";
            ledger: CfdImportStatus;
          };
          latestStatus = result.ledger;
          setCfdUploads((current) => current.map((item, itemIndex) =>
            itemIndex === index
              ? {
                  ...item,
                  status: result.status,
                  detail: result.status === "duplicate"
                    ? locale === "zh" ? "已导入，未重复入账" : "Already imported; not counted twice"
                    : locale === "zh" ? "已验证并导入" : "Validated and imported",
                }
              : item
          ));
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : messages.settings.operationFailed;
          setCfdUploads((current) => current.map((item, itemIndex) =>
            itemIndex === index ? { ...item, status: "failed", detail } : item
          ));
        }
      }
      if (latestStatus) setCfdStatus(latestStatus);
      setMessage(
        locale === "zh"
          ? "CFD 文件处理完成。确认文件状态后可刷新账户分析。"
          : "CFD files processed. Review their status, then refresh account analysis.",
      );
    });
  }

  async function refreshAccountAnalysis() {
    await run("cfdRefresh", async () => {
      const response = await fetch("/api/backend/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "cfd", skipSync: true, tickers: [] }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage(
        locale === "zh"
          ? "账户刷新已提交。可在健康页面查看各阶段进度。"
          : "Account refresh submitted. Follow stage progress on Health.",
      );
    });
  }

  async function saveAutomationSettings() {
    if (!automation || !automationDraft) return;
    await run("automation", async () => {
      const response = await fetch("/api/backend/settings/automation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...automationDraft,
          intradayEnabled: automationDraft.liveEnabled,
          nightlyEnabled: automationDraft.researchEnabled,
          expectedRevision: automation.revision,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const saved = (await response.json()) as AutomationSettings;
      setAutomation(saved);
      setAutomationDraft({
        liveEnabled: saved.liveEnabled ?? saved.intradayEnabled,
        performanceEnabled: saved.performanceEnabled ?? saved.nightlyEnabled,
        researchEnabled: saved.researchEnabled ?? saved.nightlyEnabled,
      });
      setMessage(
        locale === "zh"
          ? "自动更新设置已保存并立即生效。"
          : "Automatic refresh settings saved and applied immediately.",
      );
    });
  }

  async function saveCfdPreference() {
    await run("cfdPreference", async () => {
      const response = await fetch("/api/backend/settings/cfd", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountStatus: cfdRetired ? "retired" : "active" }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const saved = (await response.json()) as CfdImportStatus;
      setCfdStatus(saved);
      setCfdRetired(saved.accountStatus === "retired");
      setMessage(
        saved.accountStatus === "retired"
          ? locale === "zh"
            ? "CFD 已标记为停用；保留账户轨迹，不再提示数据过期。"
            : "CFD marked as retired. Its account history remains, with no stale reminders."
          : locale === "zh"
            ? "CFD 已恢复为仍在使用；系统会继续检查导入是否过期。"
            : "CFD marked active. Import freshness checks are enabled again.",
      );
    });
  }

  const deploymentLabel =
    overview?.deploymentMode === "personal_tailnet"
      ? locale === "zh"
        ? "Tailnet 私有访问"
        : "Private Tailnet access"
      : messages.settings.localWorkstation;

  return (
    <Stack gap="xl">
      {message ? <Alert aria-live="polite" color="green" icon={<CheckCircleIcon size={18} />} role="status">{message}</Alert> : null}
      {error ? <Alert color="red" icon={<Warning size={18} />} role="alert">{error}</Alert> : null}

      <section aria-labelledby="integrations-title">
        <Group align="center" justify="space-between" mb="lg" wrap="nowrap">
          <Title id="integrations-title" order={2}>{locale === "zh" ? "账户数据源" : "Account data sources"}</Title>
          <ThemeIcon color="brand" size="lg" variant="light"><Plug size={21} /></ThemeIcon>
        </Group>

        <SimpleGrid cols={{ base: 1, lg: 2 }}>
          {(["invest", "isa"] as const).map((account) => {
            const item = integration(overview, "trading212", account);
            const values = trading212[account];
            const test = tradingTests[account];
            const complete = Boolean(values.apiKeyId && values.secretKey);
            return (
              <Card h="100%" key={account}>
                <Stack gap="md">
                  <Group align="flex-start" justify="space-between" wrap="nowrap">
                    <Stack gap="xs">
                      <Group gap="xs" wrap="nowrap">
                        <Title order={3}>
                          {messages.settings.trading212} ·{" "}
                          {account === "invest" ? messages.settings.invest : messages.settings.isa}
                        </Title>
                        <ContextHelp
                          content={messages.settings.noSecretReturned}
                          label={locale === "zh" ? "凭据保存方式" : "How credentials are stored"}
                          title={locale === "zh" ? "凭据只保存在本机" : "Credentials stay on this machine"}
                        />
                      </Group>
                      <Group gap="sm" wrap="wrap">
                        <Badge color={item?.configured ? "green" : "gray"}>
                          {item?.configured ? messages.settings.configured : messages.settings.notConfigured}
                        </Badge>
                        {item?.lastTestAt ? (
                          <Text c="dimmed" size="xs">
                            {messages.settings.lastTest} {formatDateTime(item.lastTestAt, locale, timeZone)}
                          </Text>
                        ) : null}
                      </Group>
                    </Stack>
                    <ThemeIcon color={item?.configured ? "green" : "gray"} variant="light"><Key size={19} /></ThemeIcon>
                  </Group>
                <Accordion multiple variant="contained">
                  <Accordion.Item value={`${account}-credentials`}>
                    <Accordion.Control>
                      {item?.configured
                        ? locale === "zh" ? "替换凭据" : "Replace credentials"
                        : messages.settings.setupConnection}
                    </Accordion.Control>
                    <Accordion.Panel>
                <Stack gap="md">
                <SecretInput
                  id={`trading212-${account}-api-key-id`}
                  label={messages.settings.apiKeyId}
                  onChange={(value) => updateTrading212(account, "apiKeyId", value)}
                  value={values.apiKeyId}
                />
                <SecretInput
                  id={`trading212-${account}-secret-key`}
                  label={messages.settings.secretKey}
                  onChange={(value) => updateTrading212(account, "secretKey", value)}
                  value={values.secretKey}
                />

                <Group wrap="wrap">
                  <TestBadge state={test} />
                  {test.status === "idle" ? <Text c="dimmed" size="xs">{messages.settings.testRequired}</Text> : null}
                </Group>
                <Group>
                  <Button
                    disabled={isBusy(account) || !complete}
                    loading={isBusy(account)}
                    onClick={() => void testTrading212(account)}
                    variant="default"
                  >
                    {messages.settings.test}
                  </Button>
                  <Button
                    disabled={isBusy(account) || test.status !== "passed"}
                    onClick={() => void saveTrading212(account)}
                  >
                    {messages.settings.saveConnection}
                  </Button>
                </Group>
                </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                  {item?.configured ? (
                    <Accordion.Item value={`${account}-disconnect`}>
                      <Accordion.Control>
                        <Text c="red" fw={700}>{messages.settings.disconnect}</Text>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Button
                          aria-label={messages.settings.disconnect}
                          color="red"
                          disabled={isBusy(account)}
                          leftSection={<Trash size={18} />}
                          onClick={() => void disconnectTrading212(account)}
                          variant="light"
                        >
                          {locale === "zh" ? "删除已保存凭据" : "Delete saved credentials"}
                        </Button>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ) : null}
                </Accordion>
                </Stack>
              </Card>
            );
          })}

        </SimpleGrid>

        <CfdImportCard
          busy={isBusy("cfdImport")}
          cfdRetired={cfdRetired}
          locale={locale}
          onCfdRetiredChange={setCfdRetired}
          onPreferenceSave={() => void saveCfdPreference()}
          onRefresh={() => void refreshAccountAnalysis()}
          onSelect={selectCfdFiles}
          onUpload={() => void uploadCfdFiles()}
          preferenceBusy={isBusy("cfdPreference")}
          refreshBusy={isBusy("cfdRefresh")}
          status={cfdStatus}
          uploads={cfdUploads}
        />

        <Accordion mt="lg" variant="contained">
          <Accordion.Item value="optional-research-services">
            <Accordion.Control>
              <Group align="center" justify="space-between" pr="md" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon color="violet" size="lg" variant="light">
                    <Sparkle size={20} weight="fill" />
                  </ThemeIcon>
                  <div>
                    <Title order={3}>
                      {locale === "zh" ? "可选研究增强" : "Optional research enhancements"}
                    </Title>
                    <Text c="dimmed" size="sm">
                      {locale === "zh"
                        ? "模糊标的搜索、自动分类和摘要"
                        : "Fuzzy security search, classification, and summaries"}
                    </Text>
                  </div>
                </Group>
                <Badge color={configuredLlmCount ? "green" : "gray"} variant="light">
                  {configuredLlmCount
                    ? locale === "zh" ? `已连接 ${configuredLlmCount} 个` : `${configuredLlmCount} connected`
                    : locale === "zh" ? "可选" : "Optional"}
                </Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="lg">
                <Text size="sm">
                  {locale === "zh"
                    ? "无需配置即可完整使用；连接后只在确定性流程无法完成时启用。"
                    : "Trading Max works without these services. When connected, they run only after deterministic paths cannot finish the task."}
                </Text>
                <SimpleGrid cols={{ base: 1, lg: 2 }}>
                  {(["opencode", "deepseek"] as const).map((provider) => {
                    const descriptor = providerDescriptor(provider);
                    const item = integration(overview, provider);
                    const values = llm[provider];
                    const test = llmTests[provider];
                    const complete = Boolean(values.apiKey && values.model);
                    return (
                      <Card h="100%" key={provider} withBorder>
                        <Stack gap="md">
                          <Group align="flex-start" justify="space-between" wrap="nowrap">
                            <Stack gap={4}>
                              <Group gap="xs" wrap="nowrap">
                                <Title order={3}>{descriptor.label}</Title>
                                <ContextHelp
                                  content={messages.settings.noSecretReturned}
                                  label={locale === "zh" ? `${descriptor.label} 凭据说明` : `${descriptor.label} credential details`}
                                  title={locale === "zh" ? "密钥保存在本机" : "Key stored on this device"}
                                />
                              </Group>
                              <Text c="dimmed" size="sm">
                                {provider === "opencode"
                                  ? locale === "zh" ? "通过 OpenCode Go 使用 DeepSeek" : "DeepSeek through OpenCode Go"
                                  : locale === "zh" ? "直接连接 DeepSeek" : "Direct DeepSeek connection"}
                              </Text>
                            </Stack>
                            <Badge color={item?.configured ? "green" : "gray"}>
                              {item?.configured ? messages.settings.configured : messages.settings.notConfigured}
                            </Badge>
                          </Group>

                          <SecretInput
                            id={`${provider}-api-key`}
                            label={messages.settings.apiKey}
                            onChange={(value) => updateLlm(provider, "apiKey", value)}
                            value={values.apiKey}
                          />
                          <Select
                            data={descriptor.models.map((model) => ({
                              value: model,
                              label: formatModelLabel(model),
                            }))}
                            id={`${provider}-model`}
                            label={messages.settings.model}
                            onChange={(value) => value && updateLlm(provider, "model", value)}
                            value={values.model}
                          />
                          <Group wrap="wrap">
                            <TestBadge state={test} />
                            {test.status === "idle" ? (
                              <Text c="dimmed" size="xs">{messages.settings.testRequired}</Text>
                            ) : null}
                          </Group>
                          <Group wrap="wrap">
                            <Button
                              disabled={isBusy(provider) || !complete}
                              loading={isBusy(provider)}
                              onClick={() => void testLlm(provider)}
                              variant="default"
                            >
                              {messages.settings.test}
                            </Button>
                            <Button
                              disabled={isBusy(provider) || test.status !== "passed"}
                              onClick={() => void saveLlm(provider)}
                            >
                              {messages.settings.saveConnection}
                            </Button>
                            {item?.configured ? (
                              <Button
                                aria-label={messages.settings.disconnect}
                                color="red"
                                disabled={isBusy(provider)}
                                leftSection={<Trash size={18} />}
                                onClick={() => void disconnectLlm(provider)}
                                variant="subtle"
                              >
                                {messages.settings.disconnect}
                              </Button>
                            ) : null}
                          </Group>
                        </Stack>
                      </Card>
                    );
                  })}
                </SimpleGrid>

                {configuredLlmCount ? (
                  <Accordion variant="separated">
                    <Accordion.Item value="advanced-routing">
                      <Accordion.Control>
                        {locale === "zh" ? "高级选择" : "Advanced selection"}
                      </Accordion.Control>
                      <Accordion.Panel>
                        <RoutingPolicyCard
                          busy={isBusy("routePolicy")}
                          onChange={updateRoutePolicy}
                          onSave={() => void saveRoutePolicy()}
                          options={routeOptions}
                          value={routePolicy}
                        />
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                ) : null}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </section>

      <AutomationSettingsCard
        busy={isBusy("automation")}
        draft={automationDraft}
        locale={locale}
        onChange={setAutomationDraft}
        onSave={() => void saveAutomationSettings()}
        settings={automation}
      />

      <PrivacyAccessAccordion
        deploymentLabel={deploymentLabel}
        locale={locale}
        note={messages.settings.noLoginNote}
        privateStoreLabel={messages.settings.privateStore}
      />
    </Stack>
  );
}

function PrivacyAccessAccordion({
  deploymentLabel,
  locale,
  note,
  privateStoreLabel,
}: {
  deploymentLabel: string;
  locale: "zh" | "en";
  note: string;
  privateStoreLabel: string;
}) {
  return (
    <section aria-labelledby="privacy-access-title">
      <Accordion variant="contained">
        <Accordion.Item value="privacy-access">
          <Accordion.Control>
            <Group justify="space-between" pr="md" wrap="nowrap">
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon color="blue" variant="light"><LockKey size={19} weight="fill" /></ThemeIcon>
                <div>
                  <Title id="privacy-access-title" order={2} size="h3">
                    {locale === "zh" ? "隐私与访问" : "Privacy & access"}
                  </Title>
                  <Text c="dimmed" size="sm">{deploymentLabel}</Text>
                </div>
              </Group>
              <Badge color="blue" variant="light">{privateStoreLabel}</Badge>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="md">
              <Text c="dimmed" size="sm">{note}</Text>
              <Text c="dimmed" size="sm">
                {locale === "zh"
                  ? "凭据保存在这台设备的系统凭据库中，不会显示在页面或导出文件里。"
                  : "Credentials stay in this device's system credential store and never appear on pages or in exports."}
              </Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </section>
  );
}

function AutomationSettingsCard({
  busy,
  draft,
  locale,
  onChange,
  onSave,
  settings,
}: {
  busy: boolean;
  draft: AutomationDraft | null;
  locale: "zh" | "en";
  onChange: (value: AutomationDraft) => void;
  onSave: () => void;
  settings: AutomationSettings | null;
}) {
  const { timeZone } = useLocale();
  const changed = Boolean(
    settings &&
      draft &&
      ((settings.liveEnabled ?? settings.intradayEnabled) !== draft.liveEnabled ||
        (settings.performanceEnabled ?? settings.nightlyEnabled) !== draft.performanceEnabled ||
        (settings.researchEnabled ?? settings.nightlyEnabled) !== draft.researchEnabled),
  );
  const liveIntervalMinutes = Math.round(
    (settings?.liveIntervalSeconds ?? settings?.intradayIntervalSeconds ?? 600) / 60,
  );
  const performanceIntervalMinutes = Math.round(
    (settings?.performanceIntervalSeconds ?? 1_800) / 60,
  );
  const researchSchedule = settings?.researchLocalTimes?.length
    ? settings.researchLocalTimes
    : settings?.nightlyLocalTimes?.length
      ? settings.nightlyLocalTimes
      : settings?.nightlyLocalTime
        ? [settings.nightlyLocalTime]
      : [];
  const sourceTimeZone = settings?.researchTimezone ?? "Europe/London";
  const researchTimes = formatScheduleTimes(
    researchSchedule.length ? researchSchedule : ["06:30", "12:00", "17:30", "22:30"],
    locale,
    sourceTimeZone,
    timeZone,
  ).join(" · ");
  const timeZoneLabel = formatTimeZoneLabel(timeZone, locale);
  return (
    <section aria-labelledby="automation-settings-title">
      <Card>
        <Stack gap="lg">
          <Group align="flex-start" justify="space-between" wrap="nowrap">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Title id="automation-settings-title" order={2}>
                {locale === "zh" ? "自动化" : "Automation"}
              </Title>
            </div>
            <ThemeIcon color="brand" size="lg" variant="light"><ClockCountdown size={21} /></ThemeIcon>
          </Group>

          <SimpleGrid cols={{ base: 1, md: 3 }}>
            <Stack
              className="tm-settings-option"
              gap="sm"
              p="md"
            >
              <Switch
                aria-label={locale === "zh" ? "启用实时账户与持仓" : "Enable live account and holdings"}
                checked={draft?.liveEnabled ?? false}
                disabled={!draft || busy}
                label={locale === "zh" ? "实时账户与持仓" : "Live account & holdings"}
                onChange={(event) => draft && onChange({
                  ...draft,
                  liveEnabled: event.currentTarget.checked,
                })}
                size="md"
                styles={{ root: { minHeight: 44 } }}
              />
              <Text c="dimmed" size="sm">
                {locale === "zh"
                  ? `每 ${liveIntervalMinutes} 分钟 · 全天候`
                  : `Every ${liveIntervalMinutes} minutes · 24/7`}
              </Text>
            </Stack>
            <Stack
              className="tm-settings-option"
              gap="sm"
              p="md"
            >
              <Switch
                aria-label={locale === "zh" ? "启用绩效与复盘" : "Enable performance and review"}
                checked={draft?.performanceEnabled ?? false}
                disabled={!draft || busy}
                label={locale === "zh" ? "绩效与复盘" : "Performance & review"}
                onChange={(event) => draft && onChange({
                  ...draft,
                  performanceEnabled: event.currentTarget.checked,
                })}
                size="md"
                styles={{ root: { minHeight: 44 } }}
              />
              <Text c="dimmed" size="sm">
                {locale === "zh"
                  ? `每 ${performanceIntervalMinutes} 分钟 · 账户重大变化时`
                  : `Every ${performanceIntervalMinutes} minutes · on material account changes`}
              </Text>
            </Stack>
            <Stack
              className="tm-settings-option"
              gap="sm"
              p="md"
            >
              <Switch
                aria-label={locale === "zh" ? "启用研究与穿透" : "Enable research and look-through"}
                checked={draft?.researchEnabled ?? false}
                disabled={!draft || busy}
                label={locale === "zh" ? "研究与穿透" : "Research & look-through"}
                onChange={(event) => draft && onChange({
                  ...draft,
                  researchEnabled: event.currentTarget.checked,
                })}
                size="md"
                styles={{ root: { minHeight: 44 } }}
              />
              <Text c="dimmed" size="sm">
                {locale === "zh"
                  ? `${timeZoneLabel} ${researchTimes} · 周末照常`
                  : `${timeZoneLabel} ${researchTimes} · weekends included`}
              </Text>
            </Stack>
          </SimpleGrid>

          <Group justify="flex-end">
            <Button disabled={!changed || busy} loading={busy} onClick={onSave}>
              {locale === "zh" ? "保存更改" : "Save changes"}
            </Button>
          </Group>
        </Stack>
      </Card>
    </section>
  );
}

function CfdImportCard({
  busy,
  cfdRetired,
  locale,
  onCfdRetiredChange,
  onPreferenceSave,
  onRefresh,
  onSelect,
  onUpload,
  preferenceBusy,
  refreshBusy,
  status,
  uploads,
}: {
  busy: boolean;
  cfdRetired: boolean;
  locale: "zh" | "en";
  onCfdRetiredChange: (value: boolean) => void;
  onPreferenceSave: () => void;
  onRefresh: () => void;
  onSelect: (files: FileList | null) => void;
  onUpload: () => void;
  preferenceBusy: boolean;
  refreshBusy: boolean;
  status: CfdImportStatus | null;
  uploads: CfdUpload[];
}) {
  const { timeZone } = useLocale();
  const formatImportDate = (value: string | null) => {
    if (!value) return "—";
    return value.includes("T")
      ? formatDateTime(value, locale, timeZone)
      : formatDate(value, locale, { day: "numeric", month: "short", year: "numeric" });
  };
  const ready = uploads.some((item) => item.status === "selected" || item.status === "failed");
  const importedThisSession = uploads.some((item) => item.status === "imported" || item.status === "duplicate");
  const preferenceChanged = Boolean(
    status && cfdRetired !== (status.accountStatus === "retired"),
  );
  const uploadStatusLabel = (uploadStatus: CfdUpload["status"]) => ({
    duplicate: locale === "zh" ? "已存在" : "Already imported",
    failed: locale === "zh" ? "失败" : "Failed",
    imported: locale === "zh" ? "已导入" : "Imported",
    selected: locale === "zh" ? "待验证" : "Ready to validate",
    uploading: locale === "zh" ? "验证中" : "Validating",
  })[uploadStatus];
  return (
    <Accordion mt="lg" variant="contained">
      <Accordion.Item value="cfd-data-source">
        <Accordion.Control>
          <Group align="flex-start" gap="md" justify="space-between" pr="md" wrap="nowrap">
            <Group align="flex-start" gap="sm" wrap="nowrap">
              <ThemeIcon color="brand" size="lg" variant="light"><FileCsv size={21} /></ThemeIcon>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Title order={3}>Trading 212 · CFD CSV</Title>
                <Text c="dimmed" size="sm">
                  {status?.lastImportedAt
                    ? locale === "zh" ? `上次导入 ${formatImportDate(status.lastImportedAt)}` : `Last import ${formatImportDate(status.lastImportedAt)}`
                    : locale === "zh" ? "尚未导入" : "No imports yet"}
                </Text>
              </div>
            </Group>
            <Badge
              color={status?.isStale ? "yellow" : status?.importedFiles ? "green" : "gray"}
              variant="light"
            >
              {status?.accountStatus === "retired"
                ? locale === "zh" ? "已停用" : "Retired"
                : status?.importedFiles
                  ? locale === "zh" ? `${status.importedFiles} 个文件` : `${status.importedFiles} files`
                  : locale === "zh" ? "尚未导入" : "No imports"}
            </Badge>
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="lg">
            {status?.isStale && status.accountStatus !== "retired" ? (
              <Alert color="yellow" icon={<Warning size={18} />}>
                {locale === "zh"
                  ? `CFD 已超过 ${status.staleAfterDays} 天未导入；Invest / ISA 不受影响。`
                  : `CFD has not been imported for over ${status.staleAfterDays} days. Invest / ISA are unaffected.`}
              </Alert>
            ) : null}

            <SimpleGrid cols={{ base: 2, sm: 3 }}>
              <ImportMetric label={locale === "zh" ? "文件" : "Files"} value={String(status?.importedFiles ?? 0)} />
              <ImportMetric label={locale === "zh" ? "唯一事件" : "Unique events"} value={(status?.uniqueEvents ?? 0).toLocaleString()} />
              <ImportMetric label={locale === "zh" ? "上次导入" : "Last import"} value={formatImportDate(status?.lastImportedAt ?? null)} />
            </SimpleGrid>

            <Stack gap="md">
              <Text fw={700}>{locale === "zh" ? "导入 CSV" : "Import CSV"}</Text>
              <Group wrap="wrap">
                <Button component="label" leftSection={<UploadSimple size={18} />} variant="default">
                  {uploads.length
                    ? locale === "zh" ? "重新选择" : "Choose again"
                    : locale === "zh" ? "选择 CSV" : "Choose CSV files"}
                  <input
                    accept=".csv,text/csv"
                    hidden
                    multiple
                    onChange={(event) => onSelect(event.currentTarget.files)}
                    type="file"
                  />
                </Button>
                {uploads.length ? (
                  <Button disabled={!ready || busy} loading={busy} onClick={onUpload}>
                    {locale === "zh" ? "验证并导入" : "Validate and import"}
                  </Button>
                ) : null}
                {importedThisSession ? (
                  <Button
                    disabled={busy || refreshBusy}
                    leftSection={<ArrowClockwise size={18} />}
                    loading={refreshBusy}
                    onClick={onRefresh}
                    variant="light"
                  >
                    {locale === "zh" ? "刷新账户分析" : "Refresh account analysis"}
                  </Button>
                ) : null}
              </Group>

              {uploads.length ? (
                <Stack gap="xs">
                  {uploads.map((upload, index) => (
                    <Group justify="space-between" key={`${upload.file.name}-${index}`} wrap="nowrap">
                      <div>
                        <Text fw={600} size="sm">{upload.file.name}</Text>
                        <Text c="dimmed" size="xs">
                          {(upload.file.size / 1024).toFixed(1)} KB{upload.detail ? ` · ${upload.detail}` : ""}
                        </Text>
                      </div>
                      <Badge
                        color={upload.status === "failed" ? "red" : upload.status === "imported" ? "green" : upload.status === "duplicate" ? "gray" : "blue"}
                        variant="light"
                      >
                        {uploadStatusLabel(upload.status)}
                      </Badge>
                    </Group>
                  ))}
                </Stack>
              ) : null}
            </Stack>

            <Accordion multiple variant="separated">
              <Accordion.Item value="cfd-account-status">
                <Accordion.Control>
                  {locale === "zh"
                    ? `账户状态 · ${cfdRetired ? "已停用" : "使用中"}`
                    : `Account status · ${cfdRetired ? "Retired" : "Active"}`}
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack className="tm-settings-option" gap="md" p="md">
                    <Group align="center" justify="space-between" wrap="wrap">
                      <Group gap="xs" wrap="nowrap">
                        <Switch
                          aria-label={locale === "zh" ? "此 CFD 账户已停用" : "This CFD account is retired"}
                          checked={cfdRetired}
                          disabled={!status || preferenceBusy}
                          label={locale === "zh" ? "此 CFD 账户已停用" : "This CFD account is retired"}
                          onChange={(event) => onCfdRetiredChange(event.currentTarget.checked)}
                          size="md"
                          styles={{ root: { minHeight: 44 } }}
                        />
                        <ContextHelp
                          content={locale === "zh"
                            ? "停用后会保留账本、资金轨迹和复盘，但不再提示 CSV 过期。"
                            : "Retiring keeps the ledger, account trajectory, and review, but stops stale CSV reminders."}
                          label={locale === "zh" ? "停用账户的影响" : "What retiring changes"}
                          title={locale === "zh" ? "保留历史，停止提醒" : "Keep history, stop reminders"}
                        />
                      </Group>
                      <Button
                        disabled={!preferenceChanged || preferenceBusy}
                        loading={preferenceBusy}
                        onClick={onPreferenceSave}
                        variant="default"
                      >
                        {locale === "zh" ? "保存状态" : "Save status"}
                      </Button>
                    </Group>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
              <Accordion.Item value="imported-files">
              <Accordion.Control>
                  {locale === "zh" ? "导入记录与覆盖期" : "Import history & coverage"}
              </Accordion.Control>
              <Accordion.Panel>
                  <Stack gap="md">
                    <SimpleGrid cols={{ base: 2, md: 3 }}>
                      <ImportMetric label={locale === "zh" ? "原始行" : "Raw rows"} value={(status?.totalRawRows ?? 0).toLocaleString()} />
                      <ImportMetric label={locale === "zh" ? "去重事件" : "Duplicates removed"} value={(status?.duplicateEvents ?? 0).toLocaleString()} />
                      <ImportMetric
                        label={locale === "zh" ? "覆盖期" : "Coverage"}
                        value={`${formatImportDate(status?.coverageStartDate ?? null)} – ${formatImportDate(status?.coverageEndDate ?? null)}`}
                      />
                    </SimpleGrid>
                    {status?.files.map((file) => (
                      <Group justify="space-between" key={file.sha256} wrap="wrap">
                        <div>
                          <Text fw={600} size="sm">{file.filename}</Text>
                          <Text c="dimmed" size="xs">
                            {formatImportDate(file.coverageStartDate)} – {formatImportDate(file.coverageEndDate)} · {file.rawRows.toLocaleString()} {locale === "zh" ? "行" : "rows"}
                          </Text>
                        </div>
                        <Badge color="green" variant="light">{locale === "zh" ? "已验证" : "Validated"}</Badge>
                      </Group>
                    ))}
                    <Button
                      disabled={!status?.importedFiles || busy || refreshBusy}
                      leftSection={<ArrowClockwise size={18} />}
                      loading={refreshBusy}
                      onClick={onRefresh}
                      variant="default"
                      w="fit-content"
                    >
                      {locale === "zh" ? "刷新账户分析" : "Refresh account analysis"}
                    </Button>
                  </Stack>
              </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function ImportMetric({ label, value }: { label: string; value: string }) {
  return <div><Text c="dimmed" size="xs">{label}</Text><Text fw={700}>{value}</Text></div>;
}

function RoutingPolicyCard({
  busy,
  onChange,
  onSave,
  options,
  value,
}: {
  busy: boolean;
  onChange: (field: "defaultRoute" | "portfolio" | "ticker" | "taxonomy", value: string) => void;
  onSave: () => void;
  options: RouteOption[];
  value: RoutePolicyDraft;
}) {
  const { locale } = useLocale();
  const messages = useMessages();
  return (
    <Stack gap="md">
        <Text size="sm">
          {locale === "zh"
            ? "为不同研究任务选择首选服务；未单独指定时跟随默认选择。"
            : "Choose a preferred service for each research task. Unspecified tasks follow the default."}
        </Text>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Select
            data={options}
            label={locale === "zh" ? "默认选择" : "Default selection"}
            onChange={(next) => next && onChange("defaultRoute", next)}
            value={value.defaultRoute}
          />
          {(["portfolio", "ticker", "taxonomy"] as const).map((workload) => (
            <Select
              clearable
              data={options}
              key={workload}
              label={messages.settings.workload[workload]}
              onChange={(next) => onChange(workload, next ?? "")}
              placeholder={locale === "zh" ? "跟随默认路由" : "Use default route"}
              value={value.overrides[workload] || null}
            />
          ))}
        </SimpleGrid>
        <Button disabled={busy || !value.defaultRoute} loading={busy} onClick={onSave}>
          {locale === "zh" ? "保存选择" : "Save selection"}
        </Button>
      </Stack>
  );
}
