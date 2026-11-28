"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hasOpenDialog, WorkspaceDrawer } from "./overlay";
import { MEDIA_QUERIES } from "@/lib/breakpoints";
import { useBreakpoint } from "@/lib/hooks";
import {
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  Info,
  RotateCw,
} from "lucide-react";
import Link from "./link";
import { cloneElement, createContext, useCallback, useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { useLocale } from "@/components/locale-provider";
import { Alert } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button, CloseButton, buttonVariants } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs as TabsRoot, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty as EmptyRoot, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { CenteredCopy } from "@/ui/centered-copy";
import { formatDate, formatDateTime } from "@/ui/formatters";
import { isReadTimeout, type ChangeTone } from "./data";
import { indicatorStart, sameIndicatorTarget, type IndicatorTarget } from "./selection-indicator";
import { isImeComposing, useAltDigitModifier } from "./shortcut-platform";
import { LocalWorkspaceContext } from "./loading-context";
import { scheduleLoadingStatus, updateFailureLabel } from "./loading-state";
import { DataBasis } from "./reading-card";

export function useCopy() {
  const { locale } = useLocale();
  // Stable for a locale, so memoised chart options do not rebuild on every render.
  return useCallback((zh: string, en: string) => (locale === "zh" ? zh : en), [locale]);
}
// Continue from the indicator's rendered position when the selection changes mid-flight.
function useSelectionIndicator(host: RefObject<HTMLDivElement | null>, selector: string, selection: string) {
  const targetRef = useRef<IndicatorTarget | null>(null);
  useLayoutEffect(() => {
    const list = host.current;
    const indicator = list?.querySelector<HTMLElement>(":scope > .mx-indicator");
    if (!list || !indicator) return;
    const active = list.querySelector<HTMLElement>(selector);
    const place = (animate: boolean) => {
      const visible = Boolean(active?.getClientRects().length);
      list.toggleAttribute("data-indicated", visible);
      if (!active || !visible) {
        targetRef.current = null;
        indicator.getAnimations().forEach((animation) => animation.cancel());
        return;
      }
      const box = list.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      // Use unscaled layout offsets during a parent entrance transform.
      const exact = Math.abs(box.width - list.offsetWidth) < 1;
      const next: IndicatorTarget = {
        x: exact ? rect.left - box.left - list.clientLeft + list.scrollLeft : active.offsetLeft,
        y: exact ? rect.top - box.top - list.clientTop + list.scrollTop : active.offsetTop,
        width: exact ? rect.width : active.offsetWidth,
        height: exact ? rect.height : active.offsetHeight,
      };
      if (sameIndicatorTarget(targetRef.current, next)) return;
      const from = indicator.getBoundingClientRect();
      indicator.getAnimations().forEach((animation) => animation.cancel());
      const transform = "translate(" + next.x + "px, " + next.y + "px)";
      indicator.style.width = next.width + "px";
      indicator.style.height = next.height + "px";
      indicator.style.transform = transform;
      targetRef.current = next;
      if (!animate || window.matchMedia(MEDIA_QUERIES.reducedMotion).matches) return;
      const start = indicatorStart(from, indicator.getBoundingClientRect(), { x: next.x, y: next.y });
      if (start) indicator.animate(
        [{ transform: start }, { transform }],
        { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    };
    place(targetRef.current !== null);
    const observer = new ResizeObserver(() => place(false));
    observer.observe(list);
    if (active) observer.observe(active);
    return () => observer.disconnect();
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
    const firstButton = spans[0]?.parentElement;
    if (!firstButton) return;
    const measure = () => {
      const widest = Math.max(...spans.map((span) => span.scrollWidth));
      const track = getComputedStyle(list);
      const button = getComputedStyle(firstButton);
      const padding = parseFloat(track.paddingLeft) + parseFloat(track.paddingRight)
        + parseFloat(button.paddingLeft) + parseFloat(button.paddingRight);
      list.style.setProperty("--mx-segment-label", widest + "px");
      list.toggleAttribute("data-overlong-label", widest > list.clientWidth - padding + 1);
    };
    measure();
    // Fonts and window changes can affect the label or the space it may use.
    const observer = new ResizeObserver(measure);
    observer.observe(list);
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
const escapeLayers: Array<{ dismiss(): void; scope: RefObject<Element | null> }> = [];
let escapeListening = false;
function closeTopLayer(event: KeyboardEvent) {
  if (event.key !== "Escape" || isImeComposing(event) || event.defaultPrevented) return;
  if ((event.target as Element | null)?.closest?.('.mx-reading-source[aria-expanded="true"]')) return;
  const focusLayer = (event.target as Element | null)?.closest?.('[role="menu"], [role="dialog"], [role="alertdialog"]');
  const layer = escapeLayers.findLast(({ scope }) => !focusLayer || focusLayer.contains(scope.current));
  if (!layer) return;
  event.preventDefault();
  event.stopPropagation();
  layer.dismiss();
}
/** While opened, Escape closes this overlay first. dismiss returns focus to the overlay's trigger. */
export function useEscapeLayer(opened: boolean, scope: RefObject<Element | null>, dismiss: () => void) {
  const onDismiss = useEffectEvent(dismiss);
  useEffect(() => {
    if (!opened) return;
    const layer = { dismiss: () => onDismiss(), scope };
    escapeLayers.push(layer);
    if (!escapeListening) {
      document.addEventListener("keydown", closeTopLayer, true);
      escapeListening = true;
    }
    return () => {
      const index = escapeLayers.lastIndexOf(layer);
      if (index >= 0) escapeLayers.splice(index, 1);
    };
  }, [opened, scope]);
}

/** Supplemental text shares one delay and one collision-aware portal. */
export function Tip({
  children, label, describes = true, decorative = false, disabled, position = "top", offset = 8,
}: {
  children: ReactElement<Record<string, unknown>>;
  label: ReactNode;
  describes?: boolean;
  decorative?: boolean;
  disabled?: boolean;
  position?: "top" | "right" | "bottom-end";
  offset?: number;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const shown = open && !disabled;
  const description = [children.props["aria-describedby"], describes && shown ? id : undefined].filter(Boolean).join(" ");
  return <Tooltip disabled={disabled} onOpenChange={setOpen}>
    <TooltipTrigger render={cloneElement(children, { "aria-describedby": description || undefined })} />
    <TooltipContent id={id} side={position === "bottom-end" ? "bottom" : position}
      align={position === "bottom-end" ? "end" : "center"} sideOffset={offset} aria-hidden={decorative || undefined}>
      {label}
    </TooltipContent>
  </Tooltip>;
}

export function OverlayReading({ title, children }: { title: string; children: ReactNode }) {
  const target = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = target.current;
    if (!element) return;
    const update = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return <div className="mx-help-body" ref={target} tabIndex={overflow ? 0 : undefined}
    role={overflow ? "region" : undefined} aria-label={overflow ? title : undefined}>
    <div>{children}</div>
  </div>;
}

/** Phones read help in a bottom drawer; wider windows read it beside the trigger. */
export function Help({
  label, children, tag, basis, anchor, triggerContent, triggerLabel,
}: {
  label: ReactNode;
  /** At most three short paragraphs. No live figures: they belong to the panel. */
  children: ReactNode;
  /** A caveat tag beside a figure; it opens the explanation in place of the "?" button. */
  tag?: ReactNode;
  /** Source, method, frequency and as-of: always the last section, under 数据口径 / Data basis. */
  basis?: ReactNode;
  anchor?: HTMLElement | null;
  triggerContent?: ReactNode;
  triggerLabel?: string;
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const sheet = useBreakpoint("phone");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const explanation = typeof label === "string"
    ? label + t("说明", " explained")
    : t("查看说明", "Read explanation");
  const button = (
    <button
      ref={trigger}
      type="button"
      className={triggerContent !== undefined ? "tm-reading-trigger" : tag ? "mx-tag-help" : "mx-info"}
      aria-label={triggerLabel ?? (tag ? undefined : explanation)}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={sheet ? () => setOpen(value => !value) : undefined}
    >
      {triggerContent ?? (tag ? <>{tag}<span className="sr-only"> {explanation}</span></> : <CircleQuestionMark size={16} aria-hidden="true" />)}
    </button>
  );
  const reading = <OverlayReading title={typeof label === "string" ? label : explanation}>
    {children}
    {basis && <DataBasis>{basis}</DataBasis>}
  </OverlayReading>;

  if (sheet) return <>
    {button}
    <WorkspaceDrawer open={open} onClose={() => setOpen(false)} title={label} finalFocus={trigger}
      closeLabel={t("关闭说明", "Close explanation")}
      className="mx-help-sheet" headerClassName="mx-help-sheet-header" bodyClassName="mx-help-sheet-body">
      {reading}
    </WorkspaceDrawer>
  </>;
  return <Popover open={open} onOpenChange={setOpen} modal="trap-focus">
    <PopoverTrigger render={button} />
    <PopoverContent className="mx-help-popover" aria-labelledby={titleId}
      anchor={anchor} align="start" sideOffset={8} initialFocus={close} finalFocus={trigger}>
      <div className="mx-help-heading">
        <strong id={titleId}>{label}</strong>
        <CloseButton ref={close} aria-label={t("关闭说明", "Close explanation")} onClick={() => setOpen(false)} />
      </div>
      {reading}
    </PopoverContent>
  </Popover>;
}

export function Page({
  eyebrow,
  title,
  titleHidden = false,
  headingRef,
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
  headingRef?: RefObject<HTMLHeadingElement | null>;
  description?: ReactNode;
  /** A switch between the page's own scopes, beside its title. */
  nav?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const heading = <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className={titleHidden ? "sr-only" : undefined}>{title}</h1>;
  return (
    <div className={"mx-page " + className}>
      <ReadScope scope={typeof title === "string" ? title : undefined}>
        <header className={"mx-page-heading" + (titleHidden ? " mx-page-tools" : "")}>
          <div>
            {eyebrow && <div className="mx-eyebrow">{eyebrow}</div>}
            {nav ? <div className="mx-page-title">{heading}{nav}</div> : heading}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="mx-page-actions">{actions}</div>}
        </header>
        {children}
      </ReadScope>
    </div>
  );
}
const PanelHeadingScope = createContext(false);

export function Panel({
  title,
  description,
  help,
  helpLabel,
  helpBasis,
  helpAnchor,
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
  helpAnchor?: HTMLElement | null;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  /** A cell inside a Bento surface: same heading, no box of its own. */
  bare?: boolean;
}) {
  const parentHasTitle = useContext(PanelHeadingScope);
  return (
    <Card as="section" appearance={bare ? "plain" : "panel"} className={(bare ? "mx-bento-cell " : "") + className} id={id}>
      {(title || action) && (
        <div className="mx-panel-heading">
          <div>
            {title && (
              <div className="mx-panel-title">
                <h2>{title}</h2>
                {help && <Help label={helpLabel ?? title} basis={helpBasis} anchor={helpAnchor}>{help}</Help>}
              </div>
            )}
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      <PanelHeadingScope value={Boolean(title) || parentHasTitle}>
        <ReadScope scope={typeof title === "string" ? title : undefined}>{children}</ReadScope>
      </PanelHeadingScope>
    </Card>
  );
}
/** One surface whose sections are separated by hairlines instead of separate boxes. */
export function Bento({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <Card as="div" className={"mx-bento " + className}>{children}</Card>;
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
  return <Badge tone={tone}>{children}</Badge>;
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
      ? CircleCheck
      : tone === "warn" || tone === "bad"
        ? CircleAlert
        : Info;
  return (
    <Alert
      tone={tone}
      role={tone === "bad" ? "alert" : tone === "good" ? "status" : "note"}
    >
      <Icon aria-hidden="true" size={18} />
      <div>{children}</div>
    </Alert>
  );
}
export function Empty({
  title,
  headingLevel,
  description,
  action,
}: {
  title: ReactNode;
  /** Override the inferred level when the view supplies its own heading outside Panel. */
  headingLevel?: 2 | 3;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const hasPanelHeading = useContext(PanelHeadingScope);
  const level = headingLevel ?? (hasPanelHeading ? 3 : 2);
  return (
    <EmptyRoot>
      <EmptyTitle as={level === 2 ? "h2" : "h3"}><CenteredCopy>{title}</CenteredCopy></EmptyTitle>
      {description && <EmptyDescription><CenteredCopy>{description}</CenteredCopy></EmptyDescription>}
      {action}
    </EmptyRoot>
  );
}

/** Start empty even when a newly mounted panel is already in an error state. */
export function StatusMessage({ message, className = "sr-only" }: { message?: string; className?: string }) {
  const [announced, setAnnounced] = useState<string>();
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnounced(message), 100);
    return () => window.clearTimeout(timer);
  }, [message]);
  return <span className={className} role="status" aria-atomic="true">{announced}</span>;
}

const ReadScopeLabel = createContext<string | undefined>(undefined);

function ReadScope({ scope, children }: { scope?: string; children: ReactNode }) {
  return scope ? <ReadScopeLabel.Provider value={scope}>{children}</ReadScopeLabel.Provider> : children;
}

function useReadFailure(error?: unknown) {
  const t = useCopy();
  return isReadTimeout(error) ? t("数据请求超时", "Data request timed out")
    : t("暂时无法读取数据", "Data is temporarily unavailable");
}

/** Only the owner knows whether the fetched reading satisfies its display contract. */
export function QueryReadStatus({ failed, ready, error, label, refreshFailed = false, refreshFailureMessage }: {
  failed: boolean;
  ready: boolean;
  error?: unknown;
  label?: string;
  refreshFailed?: boolean;
  refreshFailureMessage?: string;
}) {
  const t = useCopy();
  const panel = useContext(ReadScopeLabel);
  const scope = label ?? panel;
  const readFailure = useReadFailure(error);
  const message = refreshFailureMessage ?? (refreshFailed ? t("更新失败", "Update failed") : failed ? readFailure : undefined);
  const recovered = t("数据已恢复。", "Data is available again.");
  return <ReadStatus failure={message ? [scope, message].filter(Boolean).join(" · ") : undefined}
    ready={ready} recovered={[scope, recovered].filter(Boolean).join(" · ")} />;
}

/** Keep this mounted beside the affected reading through loading, error and recovery. */
export function ReadStatus({ failure, ready, recovered }: { failure?: string; ready: boolean; recovered: string }) {
  const [lastFailure, setLastFailure] = useState<string>();
  const [recovery, setRecovery] = useState<string>();
  if (failure && lastFailure !== failure) {
    setLastFailure(failure);
    setRecovery(undefined);
  } else if (!failure && ready && lastFailure) {
    setLastFailure(undefined);
    setRecovery(recovered);
  }
  return <StatusMessage message={failure ?? (ready ? recovery : undefined)} />;
}

export function LoadingStatus({ label }: { label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => scheduleLoadingStatus(() => setVisible(true)), []);
  return (
    <div className="mx-loading-status">
      <span className="mx-loading-message" aria-hidden="true">{label}</span>
      <span className="sr-only" role="status">{visible ? label : ""}</span>
    </div>
  );
}

export function Pending({ compact = false, shape, label, height, quiet = false }: {
  compact?: boolean;
  shape?: "summary" | "holdings" | "review" | "chart" | "research" | "sectors";
  label?: string;
  height?: number;
  quiet?: boolean;
}) {
  const t = useCopy();
  return (
    <div className={`mx-loading mx-loading-${shape ?? (compact ? "compact" : "generic")}`} style={{ minHeight: height }}>
      <Skeleton className="mx-loading-shape" />
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
  retry?: () => unknown;
  showRetry?: boolean;
}) {
  const { locale, timeZone } = useLocale();
  const t = useCopy();
  const detail = useReadErrorCopy();
  if (!updatedAt) return null;
  const label = updateFailureLabel(updatedAt, locale, timeZone);
  if (!retry) return <Badge tone="warn">{label}</Badge>;
  const action = label + " · " + t("重试", "Retry");
  // The tooltip adds what to check, so it also describes the button.
  return <Tip label={detail}>
    <Badge tone="warn" className="mx-update-failure" render={<button type="button" />}
      aria-label={action} onClick={() => void retry()}>{showRetry ? action : label}</Badge>
  </Tip>;
}

export function QueryError({
  retry,
  showDataStatusLink = true,
  headingLevel,
  title,
  error,
}: {
  error?: unknown;
  retry?: () => unknown;
  showDataStatusLink?: boolean;
  headingLevel?: 2 | 3;
  title?: string;
}) {
  const t = useCopy();
  const detail = useReadErrorCopy();
  const failure = useReadFailure(error);
  const message = title ?? failure;
  return (
    <Panel>
      <Empty
        headingLevel={headingLevel}
        title={message}
        description={detail}
        action={(retry || showDataStatusLink) && (
          <div className="flex flex-wrap items-center gap-mx-md">
            {retry && (
              <Button onClick={() => void retry()}>
                <RotateCw size={16} aria-hidden="true" />
                {t("重新加载", "Try again")}
              </Button>
            )}
            {showDataStatusLink && (
              <Link href="/health" data-slot="button" className={buttonVariants({ variant: "secondary" })}>
                {t("查看数据状态", "Data status")}
              </Link>
            )}
          </div>
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
  const copy = label ?? t("数据截至", "Data as of");
  const displayDate = date
    ? /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? formatDate(date, locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
      : formatDateTime(date, locale, timeZone)
    : t("尚未更新", "Awaiting update");
  const content = <><span className="mx-status-dot" aria-hidden="true" />{copy}{" "}{displayDate}</>;
  return date
    ? <time className="mx-freshness" dateTime={date}>{content}</time>
    : <span className="mx-freshness">{content}</span>;
}
export { TextLink } from "@/components/ui/text-link";
export function Segments<T extends string>({
  value,
  onChange,
  options,
  label,
  shortcuts = false,
  compact = false,
  fullWidth = false,
  selection = "toggle",
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
  compact?: boolean;
  fullWidth?: boolean;
  /** Radio-group semantics make arrow keys move selection immediately instead of needing a second press. */
  selection?: "toggle" | "radio";
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const modifier = useAltDigitModifier();
  const bound = shortcuts && modifier != null;
  const radio = selection === "radio";
  const visibleOptions = compact ? options.filter((option) => option.compact) : options;
  const labels = visibleOptions.map((option) => option.label).join("\u0000");
  useSegmentCells(listRef, labels);
  useSelectionIndicator(listRef, radio ? '[aria-checked="true"]' : '[aria-pressed="true"]', value + labels);
  // A modifier keeps typing, speech input and screen-reader keys from switching
  // the view by accident (WCAG 2.1.4), and leaves fields and dialogs alone.
  const pick = useEffectEvent((event: KeyboardEvent) => {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.repeat || isImeComposing(event) || event.defaultPrevented) return;
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1];
    const option = digit ? options[Number(digit) - 1] : undefined;
    if (!option) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='alertdialog']")) return;
    if (hasOpenDialog()) return;
    event.preventDefault();
    if (option.value !== value) onChange(option.value);
  });
  useEffect(() => {
    if (!bound) return;
    const handle = (event: KeyboardEvent) => pick(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [bound]);
  const items = visibleOptions.map((option) => {
    const index = options.indexOf(option);
    const position = shortcuts && index < 9 ? index + 1 : null;
    const shortcut = bound ? position : null;
    const itemProps = {
      value: option.value,
      "data-compact-option": option.compact,
      "aria-keyshortcuts": shortcut ? "Alt+" + shortcut : undefined,
    };
    const labelContent = (
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
    );
    const button = radio ? (
      <RadioGroupItem key={option.value} {...itemProps}>{labelContent}</RadioGroupItem>
    ) : (
      <ToggleGroupItem key={option.value} {...itemProps}>{labelContent}</ToggleGroupItem>
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
  });
  const sharedProps = {
    ref: listRef,
    className: "mx-segments",
    "aria-label": label,
    "data-full-width": fullWidth || undefined,
  };
  return radio ? (
    <RadioGroup {...sharedProps} value={value} onValueChange={onChange}>
      {items}
      <span className="mx-indicator" aria-hidden="true" />
    </RadioGroup>
  ) : (
    <ToggleGroup {...sharedProps} value={[value]} onValueChange={([next]) => onChange(next ?? value)}>
      {items}
      <span className="mx-indicator" aria-hidden="true" />
    </ToggleGroup>
  );
}
const ReselectTab = createContext<(() => void) | undefined>(undefined);

export function TabsScope<T extends string>({
  value,
  onChange,
  children,
}: {
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <TabsRoot className="mx-tab-scope" value={value} onValueChange={onChange}>
      <ReselectTab.Provider value={() => onChange(value)}>{children}</ReselectTab.Provider>
    </TabsRoot>
  );
}

export function TabPanel({ value, children, className = "mx-tab-content" }: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return <TabsContent value={value} className={className + " mx-tab-panel"}>{children}</TabsContent>;
}

function revealTab(list: HTMLElement, tab: HTMLElement) {
  const bounds = list.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  const inset = 4;
  // Retain page scroll, including when a different tab is selected by Back.
  if (rect.left < bounds.left + inset) list.scrollLeft += rect.left - bounds.left - inset;
  else if (rect.right > bounds.right - inset) list.scrollLeft += rect.right - bounds.right + inset;
}

export function Tabs<T extends string>({
  value,
  options,
  label,
  activation = "manual",
}: {
  value: T;
  options: Array<{ value: T; label: string; short?: string; ref?: RefObject<HTMLButtonElement | null> }>;
  label: string;
  activation?: "automatic" | "manual";
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [focusedWithin, setFocusedWithin] = useState(false);
  const reselect = useContext(ReselectTab);
  const labels = options.map((option) => option.label).join("\u0000");
  useSelectionIndicator(listRef, '[aria-selected="true"]', value + labels);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
      const focused = list.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement : selected;
      if (focused) revealTab(list, focused);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [value, labels]);
  return (
    <TabsList
      ref={listRef}
      className="mx-tabs"
      aria-label={label}
      activateOnFocus={activation === "automatic"}
      onFocus={(event) => {
        setFocusedWithin(true);
        if (event.target instanceof HTMLElement) revealTab(event.currentTarget, event.target);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedWithin(false);
      }}
    >
      {options.map((option) => (
        <TabsTrigger
          key={option.value}
          value={option.value}
          ref={option.ref}
          onClick={value === option.value ? reselect : undefined}
          {...(!focusedWithin ? { tabIndex: option.value === value ? 0 : -1 } : {})}
          aria-label={option.short ? option.label : undefined}
        >
          <span className="mx-tab-label">
            {option.short ? (
              <>
                <span className="mx-tab-long">{option.label}</span>
                <span className="mx-tab-short">{option.short}</span>
              </>
            ) : option.label}
          </span>
        </TabsTrigger>
      ))}
      <span className="mx-indicator" aria-hidden="true" />
    </TabsList>
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
  return (
    <Avatar appearance="logo" className="mx-monogram mx-company-logo" aria-hidden="true">
      <AvatarImage
        className="rounded-none object-contain data-[error]:hidden data-[loading]:invisible"
        src={companyLogoSrc(ticker, isin)}
        alt=""
        keepMounted
        loading="lazy"
        decoding="async"
      />
      <AvatarFallback className="hidden rounded-none bg-transparent p-0 text-inherit [font-size:inherit] group-has-[img[data-error]]/avatar:grid group-has-[img[data-error]]/avatar:place-items-center">
        {ticker.slice(0, 2)}
      </AvatarFallback>
    </Avatar>
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
