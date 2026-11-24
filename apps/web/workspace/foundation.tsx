"use client";

import {
  Button,
  CloseButton,
  Drawer,
  Group,
  Popover,
  Tooltip,
  type TooltipProps,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  Info,
  Question,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "./link";
import { cloneElement, useCallback, useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { useLocale } from "@/components/locale-provider";
import { CenteredCopy } from "@/ui/centered-copy";
import { formatDate, formatDateTime } from "@/ui/formatters";
import { isReadTimeout, type ChangeTone } from "./data";
import { indicatorStart } from "./selection-indicator";
import { isImeComposing, useAltDigitModifier } from "./shortcut-platform";
import { LocalWorkspaceContext } from "./loading-context";
import { scheduleLoadingStatus, updateFailureLabel } from "./loading-state";
import { DataBasis } from "./reading-card";

export function useCopy() {
  const { locale } = useLocale();
  // Stable for a locale, so memoised chart options do not rebuild on every render.
  return useCallback((zh: string, en: string) => (locale === "zh" ? zh : en), [locale]);
}
// One sliding indicator for tabs and segments. The first placement is instant.
// A later move animates transform only: the indicator takes its new size at
// once, then scales and slides from wherever it currently appears (FLIP), so a
// quick second choice continues from mid-flight and layout never runs per frame.
// A segment's pill covers its whole cell; a tab's underline follows its label,
// so touch layouts can widen tabs into equal cells without stretching the line.
function useSelectionIndicator(host: RefObject<HTMLDivElement | null>, selector: string, selection: unknown) {
  useLayoutEffect(() => {
    const list = host.current;
    const indicator = list?.querySelector<HTMLElement>(":scope > .mx-indicator");
    if (!list || !indicator) return;
    const segments = list.classList.contains("mx-segments");
    // The FLIP start frame scales from the top-left corner it measures.
    indicator.style.transformOrigin = "0 0";
    let placed = "";
    const place = (animate: boolean) => {
      const active = list.querySelector<HTMLElement>(selector);
      const visible = active && active.getClientRects().length > 0;
      indicator.style.opacity = visible ? "1" : "0";
      if (!visible) { placed = ""; return; }
      const label = segments ? null : active.querySelector<HTMLElement>(":scope > .mx-tab-label");
      const anchor = label ?? active;
      // Equal-width touch cells rarely fall on whole pixels and offset* rounds, so the
      // box comes from the rendered rects. Under a scaled ancestor (an entry
      // transition) those are scaled too, and the rounded layout offsets are used.
      const box = list.getBoundingClientRect();
      const rect = anchor.getBoundingClientRect();
      const exact = Math.abs(box.width - list.offsetWidth) < 1;
      const x = exact
        ? rect.left - box.left - list.clientLeft + list.scrollLeft
        : active.offsetLeft + (label?.offsetLeft ?? 0);
      const y = !segments ? 0 : exact ? rect.top - box.top - list.clientTop + list.scrollTop : active.offsetTop;
      const width = exact ? rect.width : anchor.offsetWidth;
      const height = !segments ? indicator.offsetHeight : exact ? rect.height : active.offsetHeight;
      // A resize that moves nothing must not cut a running move short.
      const key = [x, y, width, height].map((value) => value.toFixed(2)).join(" ");
      if (key === placed) return;
      placed = key;
      const from = indicator.getBoundingClientRect();
      indicator.getAnimations().forEach((animation) => animation.cancel());
      indicator.style.width = width + "px";
      if (segments) indicator.style.height = height + "px";
      const target = "translate(" + x + "px, " + y + "px)";
      indicator.style.transform = target;
      if (!animate || !from.width || !height || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const start = indicatorStart(from, indicator.getBoundingClientRect(), { x, y });
      if (!start) return;
      indicator.animate(
        [{ transform: start }, { transform: target }],
        { duration: 200, easing: getComputedStyle(list).getPropertyValue("--mx-ease").trim() || "ease-out" },
      );
    };
    place(list.dataset.indicator === "ready");
    const frame = requestAnimationFrame(() => { list.dataset.indicator = "ready"; });
    const observer = new ResizeObserver(() => place(false));
    observer.observe(list);
    // A label can change width without the row resizing (a late web font, a phone label).
    const active = list.querySelector<HTMLElement>(selector);
    const measured = segments ? active : active?.querySelector<HTMLElement>(":scope > .mx-tab-label");
    if (measured) observer.observe(measured);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [host, selector, selection]);
}
/**
 * Touch layouts tile segments in equal cells as wide as the longest label
 * (11-touch-bento.css); a row that cannot hold them all wraps into equal rows.
 */
function useSegmentCells(host: RefObject<HTMLDivElement | null>, labels: string) {
  useLayoutEffect(() => {
    const list = host.current;
    if (!list) return;
    const spans = [...list.querySelectorAll<HTMLElement>(":scope > button > .mx-segment-label")];
    const measure = () => {
      const widest = Math.max(0, ...spans.map((span) => span.offsetWidth));
      list.style.setProperty("--mx-segment-label", Math.ceil(widest) + "px");
    };
    measure();
    // A late web font changes the labels' width without changing the options.
    const observer = new ResizeObserver(measure);
    spans.forEach((span) => observer.observe(span));
    return () => observer.disconnect();
  }, [host, labels]);
}
/** Counts changes to a text value after the first render, so only real updates animate. */
function useChangeCount(value: string | null) {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (seen.value !== value) {
    const next = { value, count: value == null ? seen.count : seen.count + 1 };
    setSeen(next);
    return next.count;
  }
  return seen.count;
}
// Open overlays, most recent last. One capture listener closes only the topmost
// layer, wherever focus is: on its trigger before focus has moved in, inside it,
// or on the page after a pointer opened it.
const escapeLayers: Array<() => void> = [];
let escapeListening = false;
function closeTopLayer(event: KeyboardEvent) {
  if (event.key !== "Escape" || isImeComposing(event) || !escapeLayers.length) return;
  // One press closes one layer; a dialog or chart behind it stays open.
  event.stopPropagation();
  escapeLayers.at(-1)!();
}
/** While opened, Escape closes this overlay first. dismiss returns focus to the overlay's trigger. */
export function useEscapeLayer(opened: boolean, dismiss: () => void) {
  const onDismiss = useEffectEvent(dismiss);
  useEffect(() => {
    if (!opened) return;
    const layer = () => onDismiss();
    escapeLayers.push(layer);
    if (!escapeListening) {
      document.addEventListener("keydown", closeTopLayer, true);
      escapeListening = true;
    }
    return () => {
      const index = escapeLayers.lastIndexOf(layer);
      if (index >= 0) escapeLayers.splice(index, 1);
    };
  }, [opened]);
}

/**
 * The shared tooltip. Styling, delays and motion come from the theme (mx-tooltip).
 * Set describes={false} when the label repeats the target's accessible name, so
 * a screen reader does not read the same words twice. Mantine merges the target's
 * own props last, so an explicit undefined there drops the description link it adds;
 * a target with its own aria-describedby keeps that one either way.
 */
export function Tip({ children, describes = true, ...props }: Omit<TooltipProps, "children"> & { children: ReactElement<Record<string, unknown>>; describes?: boolean }) {
  return <Tooltip events={{ hover: true, focus: true, touch: false }} {...props}>
    {describes ? children : cloneElement(children, { "aria-describedby": undefined })}
  </Tooltip>;
}

/** Phones read help in a bottom sheet; wider windows in a popover beside the "?". */
const HELP_SHEET = "(max-width: 767px)";

export function Help({
  label,
  children,
  tag,
  basis,
}: {
  label: ReactNode;
  /** At most three short paragraphs. No live figures: they belong to the panel. */
  children: ReactNode;
  /** A caveat tag beside a figure; it opens the explanation in place of the "?" button. */
  tag?: ReactNode;
  /** Source, method, frequency and as-of: always the last section, under 数据口径 / Data basis. */
  basis?: ReactNode;
}) {
  const t = useCopy();
  const [opened, setOpened] = useState(false);
  const sheet = useMediaQuery(HELP_SHEET) ?? false;
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEscapeLayer(opened, () => {
    setOpened(false);
    trigger.current?.focus({ preventScroll: true });
  });
  const explanation = typeof label === "string"
    ? label + t("说明", " explained")
    : t("查看说明", "Read explanation");
  const button = (
    <button
      ref={trigger}
      type="button"
      className={tag ? "mx-tag-help" : "mx-info"}
      data-mantine-stop-propagation={opened || undefined}
      aria-label={tag ? undefined : explanation}
      aria-haspopup="dialog"
      aria-expanded={opened}
      onClick={() => setOpened((value) => !value)}
      onKeyDown={(event) => {
        if (!isImeComposing(event) && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          if (!event.repeat) setOpened((value) => !value);
        }
      }}
    >
      {tag ? <>{tag}<span className="sr-only"> {explanation}</span></> : <Question size={16} aria-hidden="true" />}
    </button>
  );
  const body = (
    <div className="mx-help-body">
      {children}
      {/* The same closing paragraph the chart panels write with DataBasis. */}
      {basis && <DataBasis>{basis}</DataBasis>}
    </div>
  );
  if (sheet) return (
    <>
      {button}
      <Drawer
        opened={opened}
        onClose={() => setOpened(false)}
        position="bottom"
        size="auto"
        title={label}
        zIndex="var(--mx-overlay-z-drawer)"
        // A tap does not focus the "?" on every phone, so the sheet hands focus back to it once closed.
        returnFocus={false}
        onExitTransitionEnd={() => trigger.current?.focus({ preventScroll: true })}
        closeButtonProps={{ "aria-label": t("关闭说明", "Close explanation") }}
        classNames={{
          inner: "mx-help-sheet-frame", overlay: "mx-help-sheet-frame", content: "mx-help-sheet",
          header: "mx-help-sheet-header", title: "mx-help-sheet-title", close: "mx-help-sheet-close", body: "mx-help-sheet-body",
        }}
      >
        {body}
      </Drawer>
    </>
  );
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={320}
      offset={8}
      middlewares={{ flip: true, shift: { padding: 16 } }}
      trapFocus
      returnFocus
      // Mantine 9.5 sets display: none while floating-ui reports the trigger as
      // detached, as on a first positioning pass or once the trigger scrolls away.
      // Focus then cannot enter (or drops to the page) and Escape stops closing it.
      hideDetached={false}
      transitionProps={{ transition: "fade", duration: 120, timingFunction: "ease-out" }}
      zIndex="var(--mx-overlay-z-popover)"
    >
      <Popover.Target>{button}</Popover.Target>
      <Popover.Dropdown className="mx-help-popover" data-mantine-stop-propagation="true"
        aria-labelledby={titleId}
        onFocusCapture={(event) => event.target.setAttribute("data-mantine-stop-propagation", "true")}
      >
        <div className="mx-help-heading">
          <strong id={titleId}>{label}</strong>
          <CloseButton
            data-autofocus
            size="sm"
            aria-label={t("关闭说明", "Close explanation")}
            data-mantine-stop-propagation="true"
            onClick={() => setOpened(false)}
          />
        </div>
        {body}
      </Popover.Dropdown>
    </Popover>
  );
}
export function Page({
  eyebrow,
  title,
  titleHidden = false,
  description,
  nav,
  actions,
  children,
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  /** Keep the heading for assistive technology when the layout names the page. */
  titleHidden?: boolean;
  description?: ReactNode;
  /** A switch between the page's own scopes, beside its title. */
  nav?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const heading = <h1 className={titleHidden ? "sr-only" : undefined}>{title}</h1>;
  return (
    <div className={"mx-page " + className}>
      <header className={"mx-page-heading" + (titleHidden ? " mx-page-tools" : "")}>
        <div>
          {eyebrow && <div className="mx-eyebrow">{eyebrow}</div>}
          {nav ? <div className="mx-page-title">{heading}{nav}</div> : heading}
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="mx-page-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
export function Panel({
  title,
  description,
  help,
  helpLabel,
  helpBasis,
  action,
  children,
  className = "",
  id,
  bare = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  /** The help's name when the title is a control rather than plain text. */
  helpLabel?: string;
  /** The help's closing 数据口径 / Data basis section. */
  helpBasis?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  /** A cell inside a Bento surface: same heading, no box of its own. */
  bare?: boolean;
}) {
  return (
    <section className={(bare ? "mx-bento-cell " : "mx-panel ") + className} id={id}>
      {(title || action) && (
        <div className="mx-panel-heading">
          <div>
            {title && (
              <div className="mx-panel-title">
                <h2>{title}</h2>
                {help && <Help label={helpLabel ?? title} basis={helpBasis}>{help}</Help>}
              </div>
            )}
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
/** One surface whose sections are separated by hairlines instead of separate boxes. */
export function Bento({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={"mx-panel mx-bento " + className}>{children}</div>;
}
export function Metric({
  label,
  value,
  note,
  tone,
  large = false,
  help,
  helpLabel,
  helpBasis,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: ChangeTone;
  large?: boolean;
  help?: ReactNode;
  /** Names the help when the label carries more than text, such as an estimate tag. */
  helpLabel?: string;
  /** The help's closing 数据口径 / Data basis section. */
  helpBasis?: ReactNode;
}) {
  const changes = useChangeCount(typeof value === "string" || typeof value === "number" ? String(value) : null);
  return (
    <div className={"mx-metric" + (large ? " mx-metric-large" : "")}>
      <div className="mx-metric-label">
        {label}
        {help && <Help label={helpLabel ?? label} basis={helpBasis}>{help}</Help>}
      </div>
      <div className={"mx-number" + (tone ? " mx-" + tone : "")}>
        <span key={changes} className="mx-number-value" data-changed={changes ? "" : undefined}>{value}</span>
      </div>
      {note && <div className="mx-metric-note">{note}</div>}
    </div>
  );
}
export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return <span className={"mx-tag mx-tag-" + tone}>{children}</span>;
}
export function Notice({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const Icon =
    tone === "good"
      ? CheckCircle
      : tone === "warn" || tone === "bad"
        ? WarningCircle
        : Info;
  return (
    <div
      className={"mx-notice mx-notice-" + tone}
      role={tone === "bad" ? "alert" : tone === "good" ? "status" : "note"}
    >
      <Icon size={18} />
      <div>{children}</div>
    </div>
  );
}
export function Empty({
  title,
  headingLevel = 3,
  description,
  action,
}: {
  title: ReactNode;
  headingLevel?: 2 | 3;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="mx-empty">
      <div className="mx-empty-mark">
        <Info size={24} />
      </div>
      <Heading><CenteredCopy>{title}</CenteredCopy></Heading>
      {description && <p><CenteredCopy>{description}</CenteredCopy></p>}
      {action}
    </div>
  );
}
export function LoadingStatus({ label }: { label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => scheduleLoadingStatus(() => setVisible(true)), []);
  return (
    <div className="mx-loading-status" role="status" aria-label={label}>
      <span className="mx-loading-message" aria-hidden="true">{label}</span>
      {visible && <span className="sr-only">{label}</span>}
    </div>
  );
}

function LoadingShape({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`mx-loading-shape ${className}`} />;
}

export function Pending({ compact = false, shape, label, height, quiet = false }: {
  compact?: boolean;
  shape?: "summary" | "holdings" | "review" | "analytics" | "chart" | "research" | "sectors";
  label?: string;
  height?: number;
  quiet?: boolean;
}) {
  const t = useCopy();
  return (
    <div className={`mx-loading mx-loading-${shape ?? (compact ? "compact" : "generic")}`} style={{ minHeight: height }}>
      <LoadingShape />
      {!quiet && <LoadingStatus label={label ?? t("正在读取数据…", "Loading data…")} />}
    </div>
  );
}

function useReadErrorCopy() {
  const t = useCopy();
  const local = useContext(LocalWorkspaceContext);
  return local ? t(
    "请检查本地工作区是否正在运行，再试一次。",
    "Check that your local workspace is running, then try again.",
  ) : t(
    "请检查与工作区服务器的连接，再试一次。",
    "Check your connection to the workspace server, then try again.",
  );
}

export function UpdateFailure({ updatedAt, retry, showRetry = false }: {
  updatedAt: number;
  retry: () => unknown;
  showRetry?: boolean;
}) {
  const { locale, timeZone } = useLocale();
  const t = useCopy();
  const detail = useReadErrorCopy();
  if (!updatedAt) return null;
  const label = updateFailureLabel(updatedAt, locale, timeZone);
  const action = label + " · " + t("重试", "Retry");
  // The tooltip adds what to check, so it also describes the button.
  return <Tip label={detail} withinPortal>
    <button type="button" className="mx-tag mx-tag-warn mx-update-failure"
      aria-label={action} onClick={() => void retry()}>{showRetry ? action : label}</button>
  </Tip>;
}

export function QueryError({
  retry,
  showDataStatusLink = true,
  title,
  error,
}: {
  error?: unknown;
  retry?: () => unknown;
  showDataStatusLink?: boolean;
  title?: string;
}) {
  const t = useCopy();
  const detail = useReadErrorCopy();
  return (
    <Panel>
      <Empty
        title={title ?? (isReadTimeout(error)
          ? t("数据请求超时", "Data request timed out") : t("暂时无法读取数据", "Data is temporarily unavailable"))}
        description={detail}
        action={(retry || showDataStatusLink) && (
          <Group>
            {retry && (
              <Button
                leftSection={<ArrowClockwise size={16} />}
                onClick={() => void retry()}
              >
                {t("重新加载", "Try again")}
              </Button>
            )}
            {showDataStatusLink && (
              <Button component={Link} href="/health" variant="default">
                {t("查看数据状态", "Data status")}
              </Button>
            )}
          </Group>
        )}
      />
    </Panel>
  );
}
export function Freshness({
  date,
  label,
}: {
  date?: string | null;
  label?: string;
}) {
  const { locale, timeZone } = useLocale();
  const t = useCopy();
  return (
    <span className="mx-freshness">
      <span className="mx-status-dot" />
      {label ?? t("数据截至", "Data as of")}{" "}
      {date
        ? /^\d{4}-\d{2}-\d{2}$/.test(date)
          ? formatDate(date, locale, {
              year: "numeric",
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })
          : formatDateTime(date, locale, timeZone)
        : t("尚未更新", "Awaiting update")}
    </span>
  );
}
export function TextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className="mx-text-link">
      {children}
      <ArrowRight size={15} />
    </Link>
  );
}
export function Segments<T extends string>({
  value,
  onChange,
  options,
  label,
  shortcuts = false,
}: {
  value: T;
  onChange: (value: T) => void;
  /** `short` is the phone label, so a switch keeps its row beside other controls; the name follows what shows. */
  options: Array<{
    value: T;
    label: string;
    short?: string;
    /** A responsive toolbar may move this option into a menu, without removing its shortcut. */
    compact?: boolean;
    /** A live state worth a dot, such as an open market; the text is read to assistive technology. */
    marker?: string;
  }>;
  label: string;
  /**
   * ⌥1–⌥9 on Apple devices and Alt+1–9 on Windows pick an option by position; one
   * control per page. Where the browser or system owns those keys, nothing is bound,
   * hinted or announced.
   */
  shortcuts?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const modifier = useAltDigitModifier();
  const bound = shortcuts && modifier != null;
  const labels = options.map((option) => option.label).join("\u0000");
  useSegmentCells(listRef, labels);
  useSelectionIndicator(listRef, '[aria-pressed="true"]', value + labels);
  // A modifier keeps typing, speech input and screen-reader keys from switching
  // the view by accident (WCAG 2.1.4), and leaves fields and dialogs alone.
  const pick = useEffectEvent((event: KeyboardEvent) => {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.repeat || isImeComposing(event) || event.defaultPrevented) return;
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1];
    const option = digit ? options[Number(digit) - 1] : undefined;
    if (!option) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']")) return;
    if (document.querySelector("[aria-modal='true']")) return;
    event.preventDefault();
    if (option.value !== value) onChange(option.value);
  });
  useEffect(() => {
    if (!bound) return;
    const handle = (event: KeyboardEvent) => pick(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [bound]);
  return (
    <div ref={listRef} className="mx-segments" role="group" aria-label={label}>
      {options.map((option, index) => {
        const position = shortcuts && index < 9 ? index + 1 : null;
        const shortcut = bound ? position : null;
        const button = (
          <button
            type="button"
            key={option.value}
            aria-pressed={value === option.value}
            data-compact-option={option.compact}
            aria-keyshortcuts={shortcut ? "Alt+" + shortcut : undefined}
            onClick={() => onChange(option.value)}
          >
            <span className="mx-segment-label">
              {option.marker && <span className="mx-segment-marker" aria-hidden="true" />}
              {option.short ? (
                <>
                  <span className="mx-segment-long">{option.label}</span>
                  <span className="mx-segment-short">{option.short}</span>
                </>
              ) : (
                option.label
              )}
              {option.marker && <span className="sr-only">{"，" + option.marker}</span>}
            </span>
          </button>
        );
        // A stable wrapper keeps the buttons mounted once the platform is known.
        return position ? (
          <Tip
            key={option.value}
            disabled={!shortcut}
            label={<span className="mx-tooltip-keys">{option.label}<kbd>{(modifier === "⌥" ? "⌥" : "Alt ") + position}</kbd></span>}
          >
            {button}
          </Tip>
        ) : button;
      })}
      <span className="mx-indicator" aria-hidden="true" />
    </div>
  );
}
/** The id of the tab that shows a value in a panel shared by its tablist. */
export function tabId(panel: string, value: string) {
  return panel + "-tab-" + value;
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label,
  activation = "automatic",
  panel,
}: {
  value: T;
  onChange: (value: T) => void;
  /** `short` is the phone label, so a long tab row fits without scrolling. */
  options: Array<{ value: T; label: string; short?: string; ref?: RefObject<HTMLButtonElement | null> }>;
  label: string;
  /**
   * "manual" lets the arrow keys, Home and End move focus only, and Enter or Space choose the tab:
   * for tabs whose panels load data or add a history entry, so passing over a tab does neither.
   */
  activation?: "automatic" | "manual";
  /** The id of the one panel the tabs share. Each tab then controls it, and the panel names its tab with tabId. */
  panel?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const labelsKey = options.map((option) => option.label).join("\u0000");
  // In manual mode the one tab stop follows focus, so Tab and Shift+Tab leave the list from the tab
  // the arrows reached; once focus has left, the stop returns to the selected tab for re-entry.
  const [focused, setFocused] = useState<T | null>(null);
  const manual = activation === "manual";
  const stop = manual && focused != null && options.some((option) => option.value === focused) ? focused : value;
  useSelectionIndicator(listRef, '[aria-selected="true"]', value + labelsKey);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const revealSelection = () => {
      const selected = list.querySelector('[aria-selected="true"]');
      if (!selected) return;
      const bounds = list.getBoundingClientRect();
      const tab = selected.getBoundingClientRect();
      // Clear the 40px edge fade as well, so the selected tab is never half faded.
      const fade = Math.min(40, bounds.width / 4);
      if (tab.left < bounds.left + fade)
        list.scrollLeft -= bounds.left + fade - tab.left;
      else if (tab.right > bounds.right - fade)
        list.scrollLeft += tab.right - (bounds.right - fade);
    };
    const markEdges = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      const edge = start && end ? "both" : start ? "start" : end ? "end" : "";
      if (edge) list.dataset.edge = edge;
      else delete list.dataset.edge;
    };
    revealSelection();
    markEdges();
    const observer = new ResizeObserver(() => {
      revealSelection();
      markEdges();
    });
    observer.observe(list);
    list.addEventListener("scroll", markEdges, { passive: true });
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", markEdges);
    };
  }, [value, labelsKey]);
  return (
    <div ref={listRef} className="mx-tabs" role="tablist" aria-label={label} onBlur={manual ? (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
    } : undefined}>
      {options.map((option, index) => (
        <button
          type="button"
          role="tab"
          key={option.value}
          ref={option.ref}
          id={panel ? tabId(panel, option.value) : undefined}
          aria-controls={panel}
          aria-label={option.short ? option.label : undefined}
          aria-selected={value === option.value}
          tabIndex={stop === option.value ? 0 : -1}
          onFocus={manual ? () => setFocused(option.value) : undefined}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const offset =
              event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : 0;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : (index + offset + options.length) % options.length;
            if (offset || event.key === "Home" || event.key === "End") {
              event.preventDefault();
              if (activation === "automatic") onChange(options[next].value);
              (
                event.currentTarget.parentElement?.children[
                  next
                ] as HTMLButtonElement
              )?.focus();
            }
          }}
        >
          <span className="mx-tab-label">
            {option.short ? (
              <>
                <span className="mx-tab-long">{option.label}</span>
                <span className="mx-tab-short">{option.short}</span>
              </>
            ) : (
              option.label
            )}
          </span>
        </button>
      ))}
      <span className="mx-indicator" aria-hidden="true" />
    </div>
  );
}
export function Facts({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="mx-facts">
      {rows.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
/** The listing's logo; an ISIN, when known, identifies it before the ticker does. */
export function companyLogoSrc(ticker: string, isin?: string | null) {
  return "/api/company-logo/" + encodeURIComponent(ticker) + (isin ? "?isin=" + encodeURIComponent(isin) : "");
}
function SecurityMark({ ticker, isin }: { ticker: string; isin?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="mx-monogram mx-company-logo" aria-hidden="true">
      {!failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={companyLogoSrc(ticker, isin)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        ticker.slice(0, 2)
      )}
    </span>
  );
}

export function Instrument({
  ticker,
  name,
  small = false,
  listing,
  detail,
  isin,
}: {
  ticker: string;
  name?: string;
  small?: boolean;
  listing?: string;
  detail?: ReactNode;
  /** Identifies the logo when the ticker is ambiguous, as fund tickers often are. */
  isin?: string | null;
}) {
  return (
    <div className={"mx-instrument" + (small ? " mx-instrument-small" : "")}>
      <SecurityMark key={ticker + (isin ?? "")} ticker={ticker} isin={isin} />
      <span>
        <strong>{ticker}{listing && <span className="mx-instrument-listing"> · {listing}</span>}</strong>
        {name && <span className="mx-instrument-name">{name}</span>}
        {detail}
      </span>
    </div>
  );
}
