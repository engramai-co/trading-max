"use client";

import { useComputedColorScheme } from "@mantine/core";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useLocale, type Locale } from "@/components/locale-provider";
import type { SectorGroup, SectorGroupingKind } from "@/lib/types";
import { formatDeltaPercent } from "@/ui/formatters";
import { industryName } from "./exposure-names";
import { useCopy } from "./foundation";
import { displaySymbol, heat, heatMix, issuerName, neighbour, squarify, type Direction, type Tile } from "./sectors-data";

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
export const FLAT_BAND = 0.0005 + 1e-9;

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
export function textWidth(text: string, size: number) {
  return [...text].reduce((width, glyph) => width + (/[\u2e80-\u9fff\uff00-\uffef]/.test(glyph) ? size : size * 0.58), 0);
}

/** Tile fill: the gain or loss hue mixed into the neutral ground by the size of the move. */
function fill(change: number | null | undefined, scheme: "light" | "dark"): CSSProperties {
  return { "--mx-heat-mix": heatMix(change, scheme) } as CSSProperties;
}

/** A sector's name strip carries its own move as a lighter wash, so the sector reads before its parts. */
function wash(change: number | null | undefined): CSSProperties {
  return { "--mx-head-mix": Math.round(Math.abs(heat(change)) * 30) + "%" } as CSSProperties;
}

export function SectorMap({ groups, kind, selected, onSelect, label }: {
  groups: SectorGroup[];
  kind: SectorGroupingKind;
  selected: string | null;
  onSelect: (key: string, subgroup?: string) => void;
  label: string;
}) {
  const map = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const element = map.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) =>
        current && Math.abs(current.w - width) < 1 && Math.abs(current.h - height) < 1 ? current : { w: width, h: height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Lay out one gap wider and taller than the map, then trim each block's far
  // edges: inner seams are one gap wide and the outer blocks meet the frame.
  const tiles = useMemo(
    () => (size ? squarify(groups.map((group) => ({ key: group.key, weight: group.weight })), { x: 0, y: 0, w: size.w + GAP, h: size.h + GAP }) : []),
    [groups, size],
  );
  const byKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const direction = ARROWS[event.key];
    if (!direction) return;
    event.preventDefault();
    const next = neighbour(tiles, key, direction);
    if (!next) return;
    onSelect(next);
    map.current?.querySelector<HTMLButtonElement>('[data-key="' + CSS.escape(next) + '"]')?.focus();
  };
  return (
    <div ref={map} className="mx-sector-map" role="group" aria-label={label}>
      {tiles.map((tile) => {
        const group = byKey.get(tile.key);
        return group ? (
          <SectorBlock key={tile.key} tile={tile} group={group} kind={kind} selected={tile.key === selected}
            onSelect={onSelect} onKeyDown={move} />
        ) : null;
      })}
    </div>
  );
}

function SectorBlock({ tile, group, kind, selected, onSelect, onKeyDown }: {
  tile: Tile;
  group: SectorGroup;
  kind: SectorGroupingKind;
  selected: boolean;
  onSelect: (key: string, subgroup?: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, key: string) => void;
}) {
  const t = useCopy();
  const { locale } = useLocale();
  const scheme = useComputedColorScheme("light");
  const left = Math.round(tile.x);
  const top = Math.round(tile.y);
  const width = Math.max(0, Math.round(tile.x + tile.w) - left - GAP);
  const height = Math.max(0, Math.round(tile.y + tile.h) - top - GAP);
  const name = groupName(group, kind, locale);
  const change = formatDeltaPercent(group.change, locale, 2);
  const roomy = width >= 104 && height >= 76;
  // A narrow sector stacks its name over its move rather than truncating the name away.
  const narrow = roomy && width < 168;
  const showName = roomy || (width >= 64 && height >= 48);
  const showChange = roomy || (width >= 44 && height >= 28);
  // The top-three streak joins the strip only where it fits whole; otherwise the block's
  // hover title and accessible name carry it, and the rail spells it out on selection.
  const chip = group.streak >= 2 ? (locale === "zh" ? `连${group.streak}日前三` : `Top 3 · ${group.streak}d`) : "";
  const chipRoom = textWidth(chip, 11) + 10 + 6;
  const showChip = roomy && chip !== ""
    && (narrow ? textWidth(change, 13) + chipRoom + 20 : textWidth(name, 13) + textWidth(change, 13) + chipRoom + 32) <= width;
  // Industry groups need the security master; until a member is classified the
  // sector shows its companies instead, as themes always do.
  const byMember = kind === "themes" || group.subgroups.length === 0;
  const items = byMember
    ? group.members.map((member) => ({ key: member.symbol, weight: member.weight }))
    : group.subgroups.map((subgroup) => ({ key: subgroup.key, weight: subgroup.weight }));
  const inner = roomy
    ? squarify(items, { x: 0, y: 0, w: width - INSET * 2 + 1, h: height - (narrow ? HEAD_NARROW : HEAD) - INSET + 1 })
    : [];
  const breadth = group.breadth;
  const counted = breadth.up + breadth.flat + breadth.down;
  const spoken = [
    name,
    change,
    locale === "zh" ? `上涨 ${breadth.up} 只，下跌 ${breadth.down} 只` : `${breadth.up} up, ${breadth.down} down`,
    group.streak < 2 ? null : locale === "zh" ? `连续 ${group.streak} 日前三` : `top three for ${group.streak} sessions`,
  ].filter(Boolean).join(t("，", ", "));
  return (
    <button
      type="button"
      className="mx-sector-block"
      data-key={group.key}
      data-tone={changeTone(group.change)}
      data-roomy={roomy ? "" : undefined}
      data-narrow={narrow ? "" : undefined}
      aria-pressed={selected}
      aria-label={spoken}
      // Blocks too small for the strip still answer on hover with all three layers.
      title={roomy && (showChip || !chip) ? undefined : spoken}
      tabIndex={selected ? 0 : -1}
      style={{ left, top, width, height, ...fill(group.change, scheme), ...wash(group.change) }}
      onClick={(event) => {
        const tileTarget = (event.target as HTMLElement).closest<HTMLElement>("[data-subgroup]");
        onSelect(group.key, byMember ? undefined : tileTarget?.dataset.subgroup);
      }}
      onKeyDown={(event) => onKeyDown(event, group.key)}
    >
      <span className="mx-sector-head" aria-hidden="true">
        {showName && <span className="mx-sector-name">{name}</span>}
        {showChange && (
          <span className="mx-sector-move">
            <span className="mx-sector-change">{change}</span>
            {showChip && <span className="mx-sector-streak">{chip}</span>}
          </span>
        )}
        {roomy && counted > 0 && (
          <span className="mx-sector-breadth">
            <i data-tone="up" style={{ flexGrow: breadth.up }} />
            <i data-tone="flat" style={{ flexGrow: breadth.flat }} />
            <i data-tone="down" style={{ flexGrow: breadth.down }} />
          </span>
        )}
      </span>
      {roomy && (
        <span className="mx-sector-tiles" aria-hidden="true">
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
            return (
              <span
                key={cell.key}
                className="mx-sector-tile"
                data-subgroup={subgroup ? subgroup.key : undefined}
                data-tone={changeTone(cellChange)}
                title={cellName + " " + formatDeltaPercent(cellChange, locale, 2)}
                style={{ left: x, top: y, width: w, height: h, ...fill(cellChange, scheme) }}
              >
                {w >= 58 && h >= 24 && <span className="mx-sector-tile-name">{cellName}</span>}
                {w >= 58 && h >= 42 && <span className="mx-sector-tile-change">{formatDeltaPercent(cellChange, locale, 2)}</span>}
              </span>
            );
          })}
        </span>
      )}
    </button>
  );
}
