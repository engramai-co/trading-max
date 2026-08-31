"use client";

import {
  Accordion,
  Alert,
  Button,
  Group,
  NumberInput,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FloppyDisk } from "@phosphor-icons/react";
import { useState } from "react";

import { ContextHelp } from "@/components/context-help";
import { useLocale } from "@/components/locale-provider";
import type {
  ValuationAssumptionsHistoryEntry,
  ValuationAssumptionsState,
  ValuationCompanyAssumptions,
} from "@/lib/types";
import { formatDateTime } from "@/ui/formatters";

const scenarios = ["bear", "base", "bull"] as const;
const fields = [
  ["revenueCagr", "营收复合增速", "Revenue CAGR"],
  ["targetFcfMargin", "目标自由现金流率", "Target FCF margin"],
  ["discountRate", "折现率", "Discount rate"],
  ["exitFcfMultiple", "退出倍数", "Exit multiple"],
  ["shareCagr", "股本复合增速", "Share CAGR"],
] as const;
type Scenario = (typeof scenarios)[number];
type Field = (typeof fields)[number][0];
type Draft = Record<Scenario, Record<Field, number | string>>;

function draftFrom(company: ValuationCompanyAssumptions): Draft {
  return Object.fromEntries(scenarios.map((scenario) => [
    scenario,
    Object.fromEntries(fields.map(([field]) => [field, company.scenarios?.[scenario]?.[field] ?? ""])),
  ])) as Draft;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function ValuationAssumptionsPanel({ ticker }: { ticker: string }) {
  const { locale, timeZone } = useLocale();
  const zh = locale === "zh";
  const scenarioLabels = {
    bear: zh ? "悲观" : "Bear",
    base: zh ? "基准" : "Base",
    bull: zh ? "乐观" : "Bull",
  } as const;
  const client = useQueryClient();
  const [draftState, setDraftState] = useState<{
    ticker: string;
    value: Draft | null;
  }>({ ticker, value: null });
  const draft = draftState.ticker === ticker ? draftState.value : null;
  const setDraft = (value: Draft | null) => setDraftState({ ticker, value });
  const assumptions = useQuery({
    queryFn: () => getJson<ValuationAssumptionsState>("/api/backend/valuation/assumptions"),
    queryKey: ["valuation-assumptions"],
  });
  const history = useQuery({
    queryFn: () => getJson<ValuationAssumptionsHistoryEntry[]>("/api/backend/valuation/assumptions/history"),
    queryKey: ["valuation-assumptions-history"],
  });
  const state = assumptions.data;
  const current = state?.companies.find((item) => item.ticker === ticker) ?? null;
  const activeDraft = draft ?? (current ? draftFrom(current) : null);
  const baseline = current ? draftFrom(current) : null;
  const dirty = Boolean(
    activeDraft
    && baseline
    && JSON.stringify(activeDraft) !== JSON.stringify(baseline),
  );
  const save = useMutation({
    mutationFn: async () => {
      if (!current || !activeDraft) throw new Error(zh ? "请选择标的" : "Select a ticker");
      const body = {
        name: current.name,
        scenarios: Object.fromEntries(scenarios.map((scenario) => [
          scenario,
          Object.fromEntries(fields.map(([field]) => {
            const value = activeDraft[scenario][field];
            return [field, value === "" ? null : Number(value)];
          })),
        ])),
        source: "manual",
      };
      const response = await fetch(`/api/backend/valuation/assumptions/${encodeURIComponent(current.ticker)}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? `Save failed (${response.status})`);
      }
      return response.json() as Promise<ValuationAssumptionsState>;
    },
    onSuccess: (next) => {
      client.setQueryData(["valuation-assumptions"], next);
      setDraft(null);
      void client.invalidateQueries({ queryKey: ["valuation-assumptions-history"] });
    },
  });

  function update(scenario: Scenario, field: Field, value: number | string) {
    if (!activeDraft) return;
    const next = { ...activeDraft, [scenario]: { ...activeDraft[scenario], [field]: value } };
    setDraft(next);
    save.reset();
  }

  return (
    <Accordion defaultValue={null} variant="contained">
      <Accordion.Item value="valuation-assumptions">
        <Accordion.Control>
          <Group justify="space-between" pr="md" wrap="nowrap">
            <Group gap={4} wrap="nowrap">
              <Title order={2} size="h3">{ticker} · {zh ? "估值场景假设" : "Valuation assumptions"}</Title>
              <ContextHelp
                content={zh
                  ? "增速、利润率与折现率按小数输入，例如 0.20 代表 20%。保存后在下次研究更新中生效。"
                  : "Enter growth, margins, and discount rates as decimals: 0.20 means 20%. Saved values apply on the next research refresh."}
                label={zh ? "查看输入说明" : "View input guidance"}
              />
            </Group>
            {state ? <Text c="dimmed" size="sm" style={{ flexShrink: 0 }}>v{state.revision}</Text> : null}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="lg">
            {assumptions.error ? <Alert color="red">{assumptions.error.message}</Alert> : null}
            {current && activeDraft ? (
              <Stack>
                <Title order={3}>{current.name}</Title>
                <Tabs defaultValue="base" keepMounted={false}>
                  <Tabs.List grow>
                    {scenarios.map((scenario) => (
                      <Tabs.Tab key={scenario} value={scenario}>
                        {scenarioLabels[scenario]}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                  {scenarios.map((scenario) => (
                    <Tabs.Panel key={scenario} pt="lg" value={scenario}>
                      <Stack maw={560}>
                        {fields.map(([field, zhLabel, enLabel]) => (
                          <NumberInput
                            decimalScale={4}
                            key={field}
                            label={zh ? zhLabel : enLabel}
                            onChange={(value) => update(scenario, field, value)}
                            placeholder={zh ? "使用模型模板" : "Use model template"}
                            value={activeDraft[scenario][field]}
                          />
                        ))}
                      </Stack>
                    </Tabs.Panel>
                  ))}
                </Tabs>
                <Group justify="flex-end">
                  <Button
                    disabled={!dirty}
                    onClick={() => {
                      setDraft(null);
                      save.reset();
                    }}
                    variant="default"
                  >
                    {zh ? "还原" : "Reset"}
                  </Button>
                  <Button
                    disabled={!dirty}
                    leftSection={<FloppyDisk size={17} />}
                    loading={save.isPending}
                    onClick={() => save.mutate()}
                  >
                    {zh ? "保存假设" : "Save assumptions"}
                  </Button>
                </Group>
                {save.isSuccess ? <Alert color="green">{zh ? "已保存；下次研究刷新生效" : "Saved; applied on the next research refresh"}</Alert> : null}
                {save.error ? <Alert color="red">{save.error.message}</Alert> : null}
              </Stack>
            ) : <Text c="dimmed">{zh ? "该标的暂无可编辑假设" : "No editable assumptions for this ticker"}</Text>}
            <Stack gap="xs">
              <Title order={3}>{zh ? "变更历史" : "Change history"}</Title>
              {(history.data ?? []).filter((entry) => entry.ticker === ticker).slice(0, 5).map((entry) => (
                <Group justify="space-between" key={entry.entryId} wrap="wrap">
                  <Text fw={700}>{entry.ticker} · rev {entry.revision}</Text>
                  <Text c="dimmed" size="sm">{formatDateTime(entry.changedAt, locale, timeZone)}</Text>
                </Group>
              ))}
            </Stack>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
