import { expect, type Locator } from "@playwright/test";

const quick = new Set(["3M", "YTD", "1Y"]);

export function selectedRange(control: Locator, label: string, phone: boolean) {
  return phone && !quick.has(label)
    ? expect(control.getByRole("button", { name: `More periods · ${label}`, exact: true })).toBeVisible()
    : expect(control.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
}

export async function chooseRange(control: Locator, label: string, phone: boolean) {
  if (phone && !quick.has(label)) {
    const item = control.page().getByRole("menuitem", { name: label, exact: true });
    // A tap that lands before the page hydrates opens nothing; tap again until the menu answers.
    await expect(async () => {
      if (!await item.isVisible()) await control.getByRole("button", { name: /^More periods/ }).click();
      await expect(item).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await item.click();
  } else {
    await control.getByRole("button", { name: label, exact: true }).click();
  }
}
