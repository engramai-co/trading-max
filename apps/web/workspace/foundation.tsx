"use client";

import {
  Button,
  CloseButton,
  Group,
  Popover,
  Tooltip,
} from "@mantine/core";
import {
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  Info,
  Question,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "./link";
import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocale } from "@/components/locale-provider";
import { CenteredCopy } from "@/ui/centered-copy";
import { formatDate, formatDateTime } from "@/ui/formatters";
import type { ChangeTone } from "./data";
import { indicatorStart } from "./selection-indicator";
import { useAltDigitModifier } from "./shortcut-platform";
import { LocalWorkspaceContext } from "./loading-context";
import { scheduleLoadingStatus, updateFailureLabel } from "./loading-state";

export function useCopy() {
  const { locale } = useLocale();
  return (zh: string, en: string) => (locale === "zh" ? zh : en);
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
export function Help({
  label,
  children,
  tag,
}: {
  label: ReactNode;
  children: ReactNode;
  /** A caveat tag beside a figure; it opens the explanation in place of the "?" button. */
  tag?: ReactNode;
}) {
  const t = useCopy();
  const [opened, setOpened] = useState(false);
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
      transitionProps={{ duration: 0 }}
      shadow="md"
    >
      <Popover.Target>
        <button
          type="button"
          className={tag ? "mx-tag-help" : "mx-info"}
          data-mantine-stop-propagation={opened || undefined}
          aria-label={
            typeof label === "string"
              ? label + t("说明", " explained")
              : t("查看说明", "Read explanation")
          }
          onClick={() => setOpened((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (!event.repeat) setOpened((value) => !value);
            }
          }}
        >
          {tag ?? <Question size={16} aria-hidden="true" />}
        </button>
      </Popover.Target>
      <Popover.Dropdown className="mx-help-popover" data-mantine-stop-propagation="true"
        onFocusCapture={(event) => event.target.setAttribute("data-mantine-stop-propagation", "true")}
      >
        <div className="mx-help-heading">
          <strong>{label}</strong>
          <CloseButton
            data-autofocus
            size="sm"
            aria-label={t("关闭说明", "Close explanation")}
            data-mantine-stop-propagation="true"
            onClick={() => setOpened(false)}
          />
        </div>
        <div className="mx-help-body">{children}</div>
      </Popover.Dropdown>
    </Popover>
  );
}
export function Page({
  eyebrow,
  title,
  titleHidden = false,
  description,
  actions,
  children,
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  /** Keep the heading for assistive technology when the layout names the page. */
  titleHidden?: boolean;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={"mx-page " + className}>
      <header className={"mx-page-heading" + (titleHidden ? " mx-page-tools" : "")}>
        <div>
          {eyebrow && <div className="mx-eyebrow">{eyebrow}</div>}
          <h1 className={titleHidden ? "sr-only" : undefined}>{title}</h1>
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
                {help && <Help label={helpLabel ?? title}>{help}</Help>}
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
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: ChangeTone;
  large?: boolean;
  help?: ReactNode;
  /** Names the help when the label carries more than text, such as an estimate tag. */
  helpLabel?: string;
}) {
  const changes = useChangeCount(typeof value === "string" || typeof value === "number" ? String(value) : null);
  return (
    <div className={"mx-metric" + (large ? " mx-metric-large" : "")}>
      <div className="mx-metric-label">
        {label}
        {help && <Help label={helpLabel ?? label}>{help}</Help>}
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
    "请检查本机工作区是否正在运行，再试一次。",
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
  return <button type="button" className="mx-tag mx-tag-warn mx-update-failure"
    title={detail} aria-label={action} onClick={() => void retry()}>{showRetry ? action : label}</button>;
}

export function QueryError({
  retry,
  showDataStatusLink = true,
}: {
  retry: () => unknown;
  showDataStatusLink?: boolean;
}) {
  const t = useCopy();
  const detail = useReadErrorCopy();
  return (
    <Panel>
      <Empty
        title={t("暂时无法读取数据", "Data is temporarily unavailable")}
        description={detail}
        action={
          <Group>
            <Button
              leftSection={<ArrowClockwise size={16} />}
              onClick={() => void retry()}
            >
              {t("重新加载", "Try again")}
            </Button>
            {showDataStatusLink && (
              <Button component={Link} href="/health" variant="default">
                {t("查看数据状态", "Data status")}
              </Button>
            )}
          </Group>
        }
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
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.repeat || event.isComposing || event.defaultPrevented) return;
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
          <Tooltip
            key={option.value}
            disabled={!shortcut}
            label={<span className="mx-nav-search-hint">{option.label}<kbd>{(modifier === "⌥" ? "⌥" : "Alt ") + position}</kbd></span>}
            openDelay={500}
            classNames={{ tooltip: "mx-nav-tooltip" }}
            transitionProps={{ duration: 0 }}
            events={{ hover: true, focus: true, touch: false }}
          >
            {button}
          </Tooltip>
        ) : button;
      })}
      <span className="mx-indicator" aria-hidden="true" />
    </div>
  );
}
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  /** `short` is the phone label, so a long tab row fits without scrolling. */
  options: Array<{ value: T; label: string; short?: string }>;
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const labelsKey = options.map((option) => option.label).join("\u0000");
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
    <div ref={listRef} className="mx-tabs" role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button
          type="button"
          role="tab"
          key={option.value}
          aria-label={option.short ? option.label : undefined}
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
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
              onChange(options[next].value);
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
function SecurityMark({ ticker }: { ticker: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="mx-monogram mx-company-logo" aria-hidden="true">
      {!failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={"/api/company-logo/" + encodeURIComponent(ticker)}
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
}: {
  ticker: string;
  name?: string;
  small?: boolean;
  listing?: string;
  detail?: ReactNode;
}) {
  return (
    <div className={"mx-instrument" + (small ? " mx-instrument-small" : "")}>
      <SecurityMark key={ticker} ticker={ticker} />
      <span>
        <strong>{ticker}{listing && <span className="mx-instrument-listing"> · {listing}</span>}</strong>
        {name && <span className="mx-instrument-name">{name}</span>}
        {detail}
      </span>
    </div>
  );
}
