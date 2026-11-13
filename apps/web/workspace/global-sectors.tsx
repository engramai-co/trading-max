"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useLocale } from "@/components/locale-provider";
import type { components } from "@/lib/api-schema";
import type { SectorGroup } from "@/lib/types";
import { formatCalendarDate, formatDeltaPercent, formatNumber } from "@/ui/formatters";
import { api, currency, percent } from "./data";
import { Empty, Help, Pending, QueryError, Segments, Tag, useCopy } from "./foundation";
import { issuerName, strongestGroup } from "./sectors-data";
import { SectorDetail, SectorList, type SectorDetailBoard } from "./sectors-detail";
import { changeTone, SectorMap } from "./sectors-map";

export type GlobalSectorBoard = components["schemas"]["GlobalSectorBoard"];
type Sector = GlobalSectorBoard["sectors"][number];
export type GlobalView = "regions" | "sectors";

export function globalView(value: string | null): GlobalView {
  return value === "sectors" ? value : "regions";
}

export function useGlobalSectors(enabled: boolean) {
  return useQuery({
    queryKey: ["global-sectors"],
    queryFn: ({ signal }) => api<GlobalSectorBoard>("/indices/global-sectors", { signal }),
    enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: 0,
  });
}

export function GlobalViewSwitch({ value, onChange, query }: {
  value: GlobalView;
  onChange: (value: GlobalView) => void;
  query: ReturnType<typeof useGlobalSectors>;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const answer = query.data;
  const help = answer && value === "sectors";
  const warning = query.isError ? t("行业报价更新失败", "Sector quotes couldn’t refresh")
    : answer?.weightsStale ? t("权重待更新", "Weights stale") : null;
  return <div className="mx-global-view-switch"><Segments label={t("全球视图", "Global view")} value={value}
    onChange={onChange} options={[
      { value: "regions", label: t("地区", "Regions") },
      { value: "sectors", label: t("行业", "Sectors") },
    ]} />
    {help && <Help label={t("全球板块地图", "Global sector map")} tag={warning ? <Tag tone="warn">{warning}</Tag> : undefined}>
      <p>{t("涨跌来自 MSCI World 的美元价格指数。面积按 iShares SWDA 持仓汇总的行业权重绘制。贡献以行业权重乘以涨跌幅估算。",
        "Moves use MSCI World USD price indices. Tile area follows sector weights from iShares SWDA holdings. Estimated contribution is the sector weight multiplied by its move.")}</p>
      {answer.weightsAsOf && <p>{t("权重截至 ", "Weights as of ") + formatCalendarDate(answer.weightsAsOf, locale)}</p>}
    </Help>}
  </div>;
}

const BAR = 5 * 60_000;
const slot = (at: string) => Math.floor(Date.parse(at) / BAR) * BAR;

/** Adapt index observations to the shared flat map, rail and phone list. */
export function adaptWorldSectors(answer: GlobalSectorBoard) {
  const weighted = answer.sectors.filter(({ weight }) => (weight ?? 0) > 0);
  const points = weighted.flatMap(({ intraday }) => intraday.map(({ at }) => slot(at))).filter(Number.isFinite);
  const first = Math.min(...points);
  const last = Math.max(...points);
  const slots = Number.isFinite(first) && Number.isFinite(last)
    ? Array.from({ length: Math.min(600, (last - first) / BAR + 1) }, (_, index) => first + index * BAR)
    : [];
  const groups: SectorGroup[] = weighted.map((sector) => {
    const changes = new Map(sector.intraday.map(({ at, move }) => [slot(at), move]));
    return {
      key: sector.gics, name: sector.name, nameZh: sector.nameZh,
      change: sector.move, weight: sector.weight ?? 0,
      path: slots.map((stamp) => changes.get(stamp) ?? null),
      ranks: sector.ranks, breadth: { up: 0, down: 0, flat: 0 },
      memberCount: 0, leader: null, streak: 0, subgroups: [], members: [],
      exposureGbp: sector.exposureGbp ?? 0,
    };
  });
  const board: SectorDetailBoard = {
    times: slots.map((stamp) => new Date(stamp).toISOString()),
    sessionDate: answer.referenceDate ?? "", rankSessions: answer.rankSessions,
    exposureBasisGbp: answer.exposureBasisGbp ?? null,
  };
  // Last five *completed* sessions belong in the rail. Today's strongest
  // sector follows today's actual move through the existing board rule.
  const strongest = strongestGroup(groups.map((group) => ({ ...group, ranks: [] })));
  return { board, groups, strongest };
}

export function GlobalSectors({ query, demo, phone, sector, onSelect, returnTo, onFocused }: {
  query: ReturnType<typeof useGlobalSectors>;
  demo: boolean;
  phone: boolean;
  sector: string | null;
  onSelect: (key: string) => void;
  returnTo: string | null;
  onFocused: () => void;
}) {
  const t = useCopy();
  const answer = query.data;
  const adapted = useMemo(() => answer ? adaptWorldSectors(answer) : null, [answer]);
  if (demo) return <section className="mx-panel">
    <Empty headingLevel={2} title={t("演示不包含全球行业行情", "Global sector quotes aren’t included in the demo")} />
  </section>;
  if (query.isPending) return <Pending />;
  if (!answer || !adapted) return <QueryError retry={query.refetch} />;
  const { board, groups, strongest } = adapted;
  if (!groups.length) return <section className="mx-panel">
    <Empty headingLevel={2} title={t("暂无全球行业权重", "Global sector weights are unavailable")} />
  </section>;
  const explicit = groups.find(({ key }) => key === sector);
  const group = explicit ?? groups.find(({ key }) => key === strongest);
  const selected = answer.sectors.find(({ gics }) => gics === group?.key);
  const heading = t("全球板块地图", "Global sector map");
  const detail = group && selected && <SectorDetail key={group.key} group={group} board={board}
    sessions={[]} kind="gics" openSubgroup={null} focusOnOpen={phone && Boolean(explicit)}
    indexFacts={<WorldSectorFacts sector={selected} answer={answer} />} />;
  return <>
    {phone ? <div className="mx-sectors-phone">
      {explicit ? detail : <SectorList groups={groups} board={board} sessions={[]} kind="gics" indexOnly
        focusKey={returnTo} onFocused={onFocused} onOpen={onSelect} />}
    </div> : <div className="mx-sectors-body mx-global-sectors-body">
      <SectorMap groups={groups} kind="gics" selected={group?.key ?? null} onSelect={onSelect} label={heading} flat />
      {detail}
    </div>}
  </>;
}

function WorldSectorFacts({ sector, answer }: { sector: Sector; answer: GlobalSectorBoard }) {
  const t = useCopy();
  const { locale } = useLocale();
  const groups = sector.groups.filter(({ move }) => move != null);
  const ranks = sector.ranks.flatMap((rank, index) =>
    rank == null ? [] : [{ rank, day: answer.rankSessions[index] }]);
  const basis = answer.exposureBasisGbp;
  const exposure = sector.exposureGbp;
  const contribution = sector.contribution;
  return <>
    {(contribution != null || ranks.length > 0 || (basis && exposure != null)) && <dl className="mx-sector-facts">
      {contribution != null && <div>
        <dt>{t("对 MSCI World 的贡献", "Contribution to MSCI World")}</dt>
        <dd>{formatNumber(contribution * 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" })} pp</dd>
      </div>}
      {ranks.length > 0 && <div>
        <dt>{t("近 5 日排名", "Last 5 sessions")}</dt>
        <dd className="mx-sector-ranks-cell"><ol className="mx-sector-ranks">
          {ranks.map(({ rank, day }) => <li key={day} data-top={rank <= 3 || undefined}
            title={formatCalendarDate(day, locale)}>{rank}</li>)}
        </ol></dd>
      </div>}
      {basis != null && basis > 0 && exposure != null && <div>
        <dt>{t("你的持仓", "Your exposure")}</dt>
        <dd>{exposure > 0 ? currency(exposure, "GBP", 0) + " · " + percent(exposure / basis, false, 1)
          : <span className="mx-muted">{t("未持有", "None")}</span>}</dd>
      </div>}
    </dl>}
    {groups.length > 0 && <div className="mx-global-sector-ledger">
      <h3>{t("行业组", "Industry groups")}</h3>
      <ol className="mx-sector-subgroups">
        {groups.map(({ gics, name, nameZh, move }) => <li key={gics} className="mx-sector-subgroup">
          <span className="mx-sector-subgroup-name">{locale === "zh" ? nameZh : name}</span>
          <span className={"mx-sector-subgroup-change mx-" + changeTone(move)}>{formatDeltaPercent(move, locale, 2)}</span>
        </li>)}
      </ol>
    </div>}
    {sector.holdings.length > 0 && <div className="mx-sector-members mx-global-sector-ledger">
      <h3>{t("主要成分股", "Top constituents")}</h3>
      <ul>
        {sector.holdings.map(({ name, weight }, index) => <li key={name + index}>
          <span className="mx-sector-member-name" title={issuerName(name)}>{issuerName(name)}</span>
          <span className="mx-sector-member-change">{percent(weight, false, 2)}</span>
        </li>)}
      </ul>
    </div>}
  </>;
}
