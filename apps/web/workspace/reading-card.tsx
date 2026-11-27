"use client";

import { createElement, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useLocale } from "@/components/locale-provider";
import { readingTree, type Reading, type ReadingLocale, type ReadingNode, type ReadingVariant } from "./chart-readout";

const readingStyles: Record<string, string> = {
  "mx-reading": "box-border grid w-max min-w-[168px] max-w-[min(280px,calc(100vw-16px))] gap-1 rounded-(--radius-popover) border border-solid border-panel-edge bg-popover p-4 text-start text-xs leading-[1.4] font-normal whitespace-normal text-popover-foreground tabular-nums shadow-(--shadow-popover) [.mx-chart-popup>&]:max-w-[min(280px,100%)] [.mx-chart-popup>&]:rounded-(--radius-tooltip) data-[variant=strip]:w-full data-[variant=strip]:min-w-0 data-[variant=strip]:max-w-none data-[variant=strip]:rounded-(--radius-tooltip) data-[variant=strip]:px-3 data-[variant=strip]:py-2.5 data-[variant=strip]:pe-14 data-[variant=strip]:[&_.mx-reading-value]:text-xl [&_[data-tone=up]]:text-gain [&_[data-tone=down]]:text-loss",
  "mx-reading-head": "flex items-baseline justify-between gap-3 font-medium text-muted-foreground",
  "mx-reading-time": "min-w-0 wrap-anywhere",
  "mx-reading-flag": "inline-flex items-center gap-1 whitespace-nowrap text-warning before:size-1.5 before:shrink-0 before:rounded-full before:bg-current",
  "mx-reading-primary": "flex min-w-0 flex-wrap items-baseline gap-x-2",
  "mx-reading-label": "me-auto inline-flex min-w-0 items-center gap-1.5 wrap-anywhere text-muted-foreground",
  "mx-reading-value": "max-w-full overflow-x-auto text-base font-semibold whitespace-nowrap [.mx-chart-popup_&]:overflow-visible [.mx-chart-popup_&]:whitespace-normal [.mx-chart-popup_&]:wrap-anywhere",
  "mx-reading-detail": "font-medium whitespace-nowrap [.mx-chart-popup_&]:max-w-full [.mx-chart-popup_&]:whitespace-normal [.mx-chart-popup_&]:wrap-anywhere",
  "mx-reading-group": "m-0 grid gap-1 [&+.mx-reading-group]:mt-1 data-[columns=2]:grid-cols-2 data-[columns=2]:gap-x-4",
  "mx-reading-ohlc": "m-0 grid grid-cols-2 gap-x-4 gap-y-1",
  "mx-reading-row": "grid min-w-0 grid-cols-[minmax(0,1fr)_fit-content(72%)] items-baseline gap-3 [&>dt]:inline-flex [&>dt]:min-w-0 [&>dt]:items-center [&>dt]:gap-1.5 [&>dt]:wrap-anywhere [&>dt]:text-muted-foreground [&>dd]:m-0 [&>dd]:min-w-0 [&>dd]:overflow-x-auto [&>dd]:text-end [&>dd]:font-medium [&>dd]:whitespace-nowrap [.mx-chart-popup_&]:[&>dd]:overflow-visible [.mx-chart-popup_&]:[&>dd]:whitespace-normal [.mx-chart-popup_&]:[&>dd]:wrap-anywhere [.mx-reading-tooltip_&]:grid-cols-[max-content_minmax(0,1fr)] [&>dd>.mx-reading-detail]:ms-1.5",
  "mx-reading-key": "shrink-0",
  "mx-reading-more": "text-muted-foreground",
};

function element(item: ReadingNode): ReactElement {
  const props: Record<string, unknown> = {};
  for (const [name, value] of item.attrs) {
    if (name === "class") {
      props.className = cn(value, readingStyles[value],
        value === "mx-reading-key" && item.tag === "i" && "h-0 w-3 border-x-0 border-t-2 border-b-0 border-solid border-(--key) data-dotted:border-dotted data-dashed:h-0.5 data-dashed:border-0 data-dashed:bg-[repeating-linear-gradient(90deg,var(--key)_0_4px,transparent_4px_6px)] data-[kind=bar]:size-2 data-[kind=bar]:rounded-sm data-[kind=bar]:border-0 data-[kind=bar]:bg-(--key)",
        value === "mx-reading-key" && item.tag === "svg" && "[&_path]:stroke-(--key) [&_path]:stroke-2 forced-colors:[&_path]:stroke-[CanvasText]",
      );
    }
    else if (name === "style") {
      const at = value.indexOf(":");
      props.style = { [value.slice(0, at)]: value.slice(at + 1) } as CSSProperties;
    } else if (name === "stroke-dasharray") props.strokeDasharray = value;
    else props[name] = value;
  }
  return createElement(item.tag, props, ...item.children.map((child) => typeof child === "string" ? child : element(child)));
}

/** The reading card in a given language; ReadingCard reads the language from the workspace. */
export function ReadingView({ reading, variant = "card", locale }: { reading: Reading; variant?: ReadingVariant; locale: ReadingLocale }) {
  return element(readingTree(reading, variant, locale));
}

/** One chart position: the time, one leading figure and at most a few supporting rows. */
export function ReadingCard({ reading, variant = "card" }: { reading: Reading; variant?: ReadingVariant }) {
  const { locale } = useLocale();
  return <ReadingView reading={reading} variant={variant} locale={locale} />;
}

/**
 * The last paragraph of a chart panel's help: where its figures come from, their basis and
 * cadence. Readings never repeat it; the exact records keep each point's own source.
 */
export function DataBasis({ children }: { children: ReactNode }) {
  const { locale } = useLocale();
  return <p className="mx-help-basis"><strong>{locale === "zh" ? "数据口径" : "Data basis"}</strong>{" "}{children}</p>;
}

