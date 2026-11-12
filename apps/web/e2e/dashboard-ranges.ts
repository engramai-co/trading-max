import { expect, type Locator } from "@playwright/test";

const quick = new Set(["3M", "YTD", "1Y"]);

export function selectedRange(control: Locator, label: string, phone: boolean) {
  return phone && !quick.has(label)
    ? expect(control.getByRole("button", { name: `More periods · ${label}`, exact: true })).toBeVisible()
    : expect(control.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
}

export async function chooseRange(control: Locator, label: string, phone: boolean) {
  if (phone && !quick.has(label)) {
    await control.getByRole("button", { name: /^More periods/ }).click();
    await control.page().getByRole("menuitem", { name: label, exact: true }).click();
  } else {
    await control.getByRole("button", { name: label, exact: true }).click();
  }
}
