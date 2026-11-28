import type { LedgerRows, LedgerWidth } from "./overview-layout-storage";

export function ledgerWidthClass(node: HTMLElement): LedgerWidth | undefined {
  const width = getComputedStyle(node).getPropertyValue("--mx-ledger-width-class").trim();
  return width === "wide" || width === "stacked" ? width : undefined;
}

/** Measure the real row styles, including the browser's table-border rounding. */
export function observeLedgerReservation(
  probe: HTMLElement,
  style: CSSStyleDeclaration,
  prefix: string,
  { stocks, funds, dateTagged = 0 }: LedgerRows,
  locale: string,
  active = () => true,
  hasMeasuredHeight?: () => boolean,
) {
  const groups = Number(stocks > 0) + Number(funds > 0);
  const table = probe.querySelector<HTMLElement>(groups === 2 ? "[data-probe-table=both]" : "[data-probe-table=single]");
  const stock = stocks > 0 ? probe.querySelector<HTMLElement>('[data-probe-phone=' + locale + '] [data-asset-class=stocks]') : null;
  const fund = funds > 0 ? probe.querySelector<HTMLElement>('[data-probe-phone=' + locale + '] [data-asset-class=funds]') : null;
  const desktopRow = table?.querySelector<HTMLElement>(".mx-ledger-row");
  const desktopTagged = table?.querySelector<HTMLElement>("[data-probe-tagged]");
  const phoneGroup = stock ?? fund;
  const phoneRow = phoneGroup?.querySelector<HTMLElement>(".mx-ledger-item:last-child");
  const phoneTagged = phoneGroup?.querySelector<HTMLElement>("[data-probe-tagged]");
  const update = () => {
    if (!probe.isConnected || !active()) {
      observer.disconnect();
      return;
    }
    if (hasMeasuredHeight?.()) return;
    const tableHeight = table?.getBoundingClientRect().height ?? 0;
    const row = tableHeight ? desktopRow : phoneRow;
    const step = row?.getBoundingClientRect().height;
    if (!step) return;
    const taggedRow = tableHeight ? desktopTagged : phoneTagged;
    const taggedStep = taggedRow?.getBoundingClientRect().height ?? step;
    const sample = tableHeight ||
      (stock?.getBoundingClientRect().height ?? 0) + (fund?.getBoundingClientRect().height ?? 0) +
      (stock && fund ? parseFloat(getComputedStyle(fund).marginBlockStart) : 0);
    // Each sample group contains two ordinary rows, one date-badged row and its header.
    const height = sample + (stocks + funds - dateTagged - groups * 2) * step + (dateTagged - groups) * taggedStep;
    style.setProperty(prefix + "-rows-size", Math.max(0, height) + "px");
    style.setProperty(prefix + "-row-step", step + "px");
  };
  const observer = new ResizeObserver(update);
  observer.observe(probe);
  for (const element of [table, stock, fund, desktopRow, desktopTagged, phoneRow, phoneTagged]) {
    if (element) observer.observe(element);
  }
  update();
  return () => observer.disconnect();
}
