"use client";

import {
  Button,
  CloseButton,
  Group,
  Popover,
  Skeleton,
  Stack,
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
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocale } from "@/components/locale-provider";
import { formatDate, formatDateTime } from "@/ui/formatters";

export function useCopy() {
  const { locale } = useLocale();
  return (zh: string, en: string) => (locale === "zh" ? zh : en);
}
// One sliding indicator for tabs and segments. The first placement is
// instant; later moves transition from wherever the indicator currently is.
function useSelectionIndicator(host: RefObject<HTMLDivElement | null>, selector: string, selection: unknown) {
  useLayoutEffect(() => {
    const list = host.current;
    const indicator = list?.querySelector<HTMLElement>(":scope > .mx-indicator");
    if (!list || !indicator) return;
    const place = () => {
      const active = list.querySelector<HTMLElement>(selector);
      indicator.style.opacity = active ? "1" : "0";
      if (!active) return;
      indicator.style.width = active.offsetWidth + "px";
      indicator.style.height = list.classList.contains("mx-segments") ? active.offsetHeight + "px" : "";
      indicator.style.transform = "translate(" + active.offsetLeft + "px, " + (list.classList.contains("mx-segments") ? active.offsetTop : 0) + "px)";
    };
    place();
    const frame = requestAnimationFrame(() => { list.dataset.indicator = "ready"; });
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [host, selector, selection]);
}
export function Help({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
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
      transitionProps={{ duration: 0 }}
      shadow="md"
    >
      <Popover.Target>
        <button
          type="button"
          className="mx-info"
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
          <Question size={16} aria-hidden="true" />
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
  description,
  actions,
  children,
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={"mx-page " + className}>
      <header className="mx-page-heading">
        <div>
          {eyebrow && <div className="mx-eyebrow">{eyebrow}</div>}
          <h1>{title}</h1>
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
  action,
  children,
  className = "",
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={"mx-panel " + className} id={id}>
      {(title || action) && (
        <div className="mx-panel-heading">
          <div>
            {title && (
              <div className="mx-panel-title">
                <h2>{title}</h2>
                {help && <Help label={title}>{help}</Help>}
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
export function Metric({
  label,
  value,
  note,
  tone,
  large = false,
  help,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: "up" | "down";
  large?: boolean;
  help?: string;
}) {
  return (
    <div className={"mx-metric" + (large ? " mx-metric-large" : "")}>
      <div className="mx-metric-label">
        {label}
        {help && <Help label={label}>{help}</Help>}
      </div>
      <div className={"mx-number" + (tone ? " mx-" + tone : "")}>{value}</div>
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
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-empty">
      <div className="mx-empty-mark">
        <Info size={24} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Pending({ compact = false }: { compact?: boolean }) {
  const t = useCopy();
  return (
    <div
      aria-busy="true"
      aria-label={t("正在加载", "Loading")}
      className="mx-loading"
    >
      <Skeleton h={18} w="30%" radius="sm" />
      <Skeleton h={compact ? 70 : 220} radius="md" />
      <Skeleton h={14} w="60%" radius="sm" />
    </div>
  );
}
export function QueryError({ retry }: { retry: () => unknown }) {
  const t = useCopy();
  return (
    <Panel>
      <Empty
        title={t("暂时无法读取数据", "Data is temporarily unavailable")}
        description={t(
          "请确认本地服务正在运行，或前往数据状态查看原因。",
          "Check that the local service is running, or open Data status for details.",
        )}
        action={
          <Group>
            <Button
              leftSection={<ArrowClockwise size={16} />}
              onClick={() => void retry()}
            >
              {t("重新加载", "Try again")}
            </Button>
            <Button component={Link} href="/health" variant="default">
              {t("查看数据状态", "Data status")}
            </Button>
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
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useSelectionIndicator(listRef, '[aria-pressed="true"]', value + options.map((option) => option.label).join("\u0000"));
  return (
    <div ref={listRef} className="mx-segments" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
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
  options: Array<{ value: T; label: string }>;
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
      if (tab.left < bounds.left) list.scrollLeft -= bounds.left - tab.left;
      else if (tab.right > bounds.right)
        list.scrollLeft += tab.right - bounds.right;
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
          {option.label}
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
export function Instrument({
  ticker,
  name,
  small = false,
}: {
  ticker: string;
  name?: string;
  small?: boolean;
}) {
  return (
    <div className={"mx-instrument" + (small ? " mx-instrument-small" : "")}>
      <span className="mx-monogram" aria-hidden="true">
        {ticker.slice(0, 2)}
      </span>
      <span>
        <strong>{ticker}</strong>
        {name && <span className="mx-instrument-name">{name}</span>}
      </span>
    </div>
  );
}
export function SectionStack({ children }: { children: ReactNode }) {
  return <Stack gap="lg">{children}</Stack>;
}
