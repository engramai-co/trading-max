"use client";

import { useComputedColorScheme } from "@/components/color-scheme-provider";
import { useId, useMemo, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";
import type { SectorGroup, SectorGroupingKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDeltaPercent } from "@/ui/formatters";
import { industryName } from "./exposure-names";
import { Tip, useCopy } from "./foundation";
import { displaySymbol, FLAT_BAND, heatMix, issuerName, neighbour, squarify, type Direction, type Tile } from "./sectors-data";
import {
  estimateTextWidth,
  fitRoomySectorHeader,
  fitTileLabel,
  TILE_TIER_PADDING,
  TILE_TIER_TEXT,
  useMeasuredBox,
  type TileMeasure,
} from "./tile-layout";

/** Space between sectors, the sector name strip (one or two lines), and the inset of a sector's tiles. */
const GAP = 3;
const HEAD = 34;
const HEAD_NARROW = 52;
const INSET = 3;
const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export function groupName(group: Pick<SectorGroup, "name" | "nameZh">, kind: SectorGroupingKind, locale: Locale) {
  return kind === "themes" ? (locale === "zh" && group.nameZh ? group.nameZh : group.name) : industryName(group.name, locale);
}

/** ±0.05% counts as unchanged, inclusive, with room for floating-point error — the server's band. */
export function changeTone(change: number | null | undefined) {
  return change == null || Math.abs(change) <= FLAT_BAND ? "flat" : change > 0 ? "up" : "down";
}

/** Hong Kong and Korean codes are numbers; a company name reads better on a tile. */
function memberLabel(member: { symbol: string; name: string } | undefined) {
  if (!member) return "";
  const symbol = displaySymbol(member.symbol);
  return /^\d/.test(symbol) ? issuerName(member.name) : symbol;
}

/** Rough rendered width: CJK glyphs are square, Latin ones a little over half as wide. */
export const textWidth = estimateTextWidth;

/** Tile fill: the gain or loss hue mixed into the neutral ground by the size of the move. */
function fill(change: number | null | undefined, scheme: "light" | "dark"): CSSProperties {
  return { "--mx-heat-mix": heatMix(change, scheme) } as CSSProperties;
}

export function SectorMap({ groups, kind, selected, onSelect, label, flat = false }: {
  groups: SectorGroup[];
  kind: SectorGroupingKind;
  selected: string | null;
  onSelect: (key: string, subgroup?: string) => void;
  label: string;
  flat?: boolean;
}) {
  const map = useRef<HTMLDivElement>(null);
  const { size, measure, budgets } = useMeasuredBox(map);
  // Lay out one gap wider and taller than the map, then trim each block's far
  // edges: inner seams are one gap wide and the outer blocks meet the frame.
  const tiles = useMemo(
    () => (size ? squarify(groups.map((group) => ({ key: group.key, weight: group.weight })), { x: 0, y: 0, w: size.w + GAP, h: size.h + GAP }) : []),
    [groups, size],
  );
  const byKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const direction = ARROWS[event.key];
    if (!direction) return;
    const next = neighbour(tiles, key, direction);
    // Preserve native viewport scrolling when no neighbour exists in the pressed direction.
    if (!next) return;
    event.preventDefault();
    onSelect(next);
    const target = map.current?.querySelector<HTMLButtonElement>('[data-key="' + CSS.escape(next) + '"]');
    target?.focus();
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <div
      ref={map}
      className={cn(
        "mx-sector-map relative overflow-clip rounded-[var(--radius-heat-tile)] bg-card transition-opacity duration-150 motion-reduce:transition-none",
        flat
          ? "h-[clamp(440px,calc(100dvh-336px),760px)]"
          : "h-[clamp(440px,calc(100dvh-230px),760px)] max-[899px]:h-[clamp(360px,50vh,520px)]",
      )}
      role="group"
      aria-label={label}
    >
      {tiles.map((tile) => {
        const group = byKey.get(tile.key);
        return group ? (
          <SectorBlock
            key={tile.key}
            tile={tile}
            group={group}
            kind={kind}
            selected={tile.key === selected}
            onSelect={onSelect}
            onKeyDown={move}
            measure={measure}
            budgets={budgets}
            flat={flat}
          />
        ) : null;
      })}
    </div>
  );
}

function SectorBlock({ tile, group, kind, selected, onSelect, onKeyDown, measure, budgets, flat }: {
  tile: Tile;
  group: SectorGroup;
  kind: SectorGroupingKind;
  selected: boolean;
  onSelect: (key: string, subgroup?: string) => void;
  measure: TileMeasure;
  budgets: ReturnType<typeof useMeasuredBox>["budgets"];
  flat: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, key: string) => void;
}) {
  const detailsId = useId();
  const t = useCopy();
  const { locale } = useLocale();
  const scheme = useComputedColorScheme("dark");
  const left = Math.round(tile.x);
  const top = Math.round(tile.y);
  const width = Math.max(0, Math.round(tile.x + tile.w) - left - GAP);
  const height = Math.max(0, Math.round(tile.y + tile.h) - top - GAP);
  const name = groupName(group, kind, locale);
  const tone = changeTone(group.change);
  const change = flat && group.change == null ? t("无报价", "No quote") : formatDeltaPercent(group.change, locale, 2);
  const changeShort = flat && group.change == null ? change : formatDeltaPercent(group.change, locale, 1);
  const roomy = width >= 104 && height >= 76;
  // A narrow roomy sector stacks its name over its move rather than truncating the name away.
  const narrow = roomy && width < 168;
  const compactFit = !roomy
    ? fitTileLabel({
        names: { full: name },
        change,
        rounded: changeShort,
        width,
        height,
        measure,
        tiers: budgets.tiers,
        startTier: "compact",
        allowWrap: false,
        allowInline: true,
        allowTight: true,
        allowChangeOnly: true,
        gapX: budgets.gapInline,
        gapY: budgets.gapStack,
      })
    : null;
  const showName = roomy || Boolean(compactFit?.showName);
  const showChange = roomy || Boolean(compactFit?.showChange);
  const visibleChange = roomy ? change : (compactFit?.change ?? change);
  const spoken =
    showChange && visibleChange !== change
      ? `${name} ${visibleChange}` + (locale === "zh" ? `（${change}）` : ` (${change})`)
      : `${name} ${change}`;
  // The top-three streak joins the strip only where it fits whole at the rendered chip size.
  const chip = group.streak >= 2 ? (locale === "zh" ? `连 ${group.streak} 日前三` : `Top 3 · ${group.streak}d`) : "";
  const { showChip, nameFits: roomyNameFits } = roomy
    ? fitRoomySectorHeader({ name, change, chip, width, narrow, measure, budgets })
    : { showChip: false, nameFits: false };
  // Industry groups need the security master; until a member is classified the
  // sector shows its companies instead, as themes always do.
  const byMember = kind === "themes" || group.subgroups.length === 0;
  const items = byMember
    ? group.members.map((member) => ({ key: member.symbol, weight: member.weight }))
    : group.subgroups.map((subgroup) => ({ key: subgroup.key, weight: subgroup.weight }));
  const inner = roomy && !flat
    ? squarify(items, { x: 0, y: 0, w: width - INSET * 2 + 1, h: height - (narrow ? HEAD_NARROW : HEAD) - INSET + 1 })
    : [];
  const breadth = group.breadth;
  const counted = breadth.up + breadth.flat + breadth.down;
  const details = [
    flat ? null : locale === "zh" ? `上涨 ${breadth.up} 只，下跌 ${breadth.down} 只` : `${breadth.up} up, ${breadth.down} down`,
    group.streak < 2 ? null : locale === "zh" ? `连续 ${group.streak} 日前三` : `top three for ${group.streak} sessions`,
  ].filter(Boolean).join(t("，", ", "));
  // Blocks too small for the full label still answer on hover and focus with all three layers.
  const complete = !flat && roomy && roomyNameFits && (showChip || !chip);
  const surfaceOnBlock = !roomy || flat;
  const headTier = compactFit?.tier ?? "roomy";
  return (
    // The block's own description (its breadth and streak) stays linked; the tooltip adds no second one.
    <Tip
      describes={false}
      disabled={complete}
      label={<span className="mx-tooltip-stack"><span>{name}</span><span>{[change, details].filter(Boolean).join(" · ")}</span></span>}
    >
      <button
        type="button"
        className={cn(
          "mx-sector-block tm-tile-interactive absolute m-0 flex flex-col overflow-clip rounded-[var(--radius-heat-tile)] border-0 p-0 text-left text-foreground transition-colors duration-150 motion-reduce:transition-none",
          surfaceOnBlock ? "tm-heat-surface" : "bg-heat-base",
        )}
        data-key={group.key}
        data-tone={tone}
        data-flat-map={flat || undefined}
        data-roomy={roomy ? "" : undefined}
        data-narrow={narrow ? "" : undefined}
        data-label-tier={compactFit?.tier}
        aria-label={!roomy || flat ? spoken : undefined}
        aria-pressed={selected}
        aria-describedby={details ? detailsId : undefined}
        tabIndex={selected ? 0 : -1}
        style={{ left, top, width, height, ...fill(group.change, scheme) }}
        onClick={(event) => {
          const tileTarget = (event.target as HTMLElement).closest<HTMLElement>("[data-subgroup]");
          onSelect(group.key, byMember ? undefined : tileTarget?.dataset.subgroup);
        }}
        onKeyDown={(event) => onKeyDown(event, group.key)}
      >
        {details && <span id={detailsId} hidden>{details}</span>}
        <span
          className={cn(
            "mx-sector-head relative flex flex-none min-w-0",
            roomy && !flat && "tm-heat-surface",
            roomy
              ? narrow
                ? "h-[52px] flex-col items-start gap-0 px-2.5 pt-2"
                : "h-[34px] items-baseline gap-1.5 px-2.5 pt-2"
              : cn(
                  compactFit?.inline ? "flex-row items-baseline gap-1.5" : "flex-col items-start gap-0.5",
                  "h-auto w-full",
                  TILE_TIER_PADDING[headTier],
                ),
          )}
          data-tone={roomy && !flat ? tone : undefined}
        >
          {showName && (
            <span
              className={cn(
                "mx-sector-name min-w-0 flex-initial truncate font-semibold",
                roomy ? "text-[13px] leading-[18px]" : TILE_TIER_TEXT[headTier],
                (!roomy || narrow) && "max-w-full",
              )}
            >
              {name}
            </span>
          )}
          {showChange && (
            <>
              {" "}
              <span
                className={cn(
                  "mx-sector-move inline-flex flex-none items-baseline gap-1.5",
                  roomy && !narrow ? "ml-auto" : "ml-0",
                )}
              >
                <span
                  className={cn(
                    "mx-sector-change font-semibold tabular-nums",
                    roomy ? "text-[13px] leading-[18px]" : TILE_TIER_TEXT[headTier],
                  )}
                >
                  {visibleChange}
                </span>
                {showChip && (
                  <span className="mx-sector-streak rounded-full bg-card px-1.5 text-xs font-semibold leading-4 text-foreground" aria-hidden="true">
                    {chip}
                  </span>
                )}
              </span>
            </>
          )}
          {roomy && counted > 0 && (
            <span className="mx-sector-breadth absolute inset-x-2.5 bottom-[5px] flex h-[3px] gap-px overflow-clip rounded-[2px]">
              <i data-tone="up" className="block min-w-0 bg-gain" style={{ flexGrow: breadth.up }} />
              <i data-tone="flat" className="block min-w-0 bg-border" style={{ flexGrow: breadth.flat }} />
              <i data-tone="down" className="block min-w-0 bg-loss" style={{ flexGrow: breadth.down }} />
            </span>
          )}
        </span>
        {roomy && !flat && (
          <span className="mx-sector-tiles relative mx-[3px] mb-[3px] flex-1" aria-hidden="true">
            {inner.map((cell) => {
              const subgroup = byMember ? undefined : group.subgroups.find((item) => item.key === cell.key);
              const member = byMember ? group.members.find((item) => item.symbol === cell.key) : undefined;
              const cellChange = subgroup?.change ?? member?.change ?? null;
              const cellName = subgroup
                ? (subgroup.key ? industryName(subgroup.name, locale) : t("其他", "Other"))
                : memberLabel(member);
              const x = Math.round(cell.x);
              const y = Math.round(cell.y);
              const w = Math.max(0, Math.round(cell.x + cell.w) - x - 1);
              const h = Math.max(0, Math.round(cell.y + cell.h) - y - 1);
              const fullChange = formatDeltaPercent(cellChange, locale, 2);
              const roundedChange = formatDeltaPercent(cellChange, locale, 1);
              const cellFit = fitTileLabel({
                names: { full: cellName },
                change: fullChange,
                rounded: roundedChange,
                width: w,
                height: h,
                measure,
                tiers: budgets.tiers,
                startTier: "compact",
                allowWrap: false,
                allowInline: false,
                allowTight: true,
                gapX: budgets.gapInline,
              });
              return (
                <Tip
                  key={cell.key}
                  disabled={cellFit.complete}
                  label={<span className="mx-tooltip-stack"><span>{cellName}</span><span>{fullChange}</span></span>}
                >
                  <span
                    className={cn(
                      "mx-sector-tile tm-heat-surface absolute flex flex-col gap-px overflow-clip rounded-[6px] text-foreground",
                      TILE_TIER_PADDING[cellFit.tier],
                      TILE_TIER_TEXT[cellFit.tier],
                    )}
                    data-subgroup={subgroup ? subgroup.key : undefined}
                    data-tone={changeTone(cellChange)}
                    data-label-tier={cellFit.tier}
                    style={{ left: x, top: y, width: w, height: h, ...fill(cellChange, scheme) }}
                  >
                    {cellFit.showName && <span className="mx-sector-tile-name min-w-0 truncate">{cellFit.name}</span>}
                    {cellFit.showChange && <span className="mx-sector-tile-change font-semibold tabular-nums">{cellFit.change}</span>}
                  </span>
                </Tip>
              );
            })}
          </span>
        )}
      </button>
    </Tip>
  );
}
