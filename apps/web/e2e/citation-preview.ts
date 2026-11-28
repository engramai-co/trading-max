import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

export async function previewCitation(page: Page, source: Locator) {
  await source.click();
  return page.locator(".mx-citation-preview[data-open]").getByRole("link");
}

export async function captureCitation(page: Page, source: Locator, filename: string) {
  const output = process.env.TM_CITATION_SHOTS;
  if (!output) return;
  await expect(await previewCitation(page, source)).toBeVisible();
  await expect(page.locator(".mx-citation-preview[data-open]")).toHaveCSS("opacity", "1");
  await page.screenshot({path:join(output, filename + ".png"), scale:"css"});
  await page.keyboard.press("Escape");
  await expect(page.locator(".mx-citation-preview")).toHaveCount(0);
}
