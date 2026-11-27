import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("reduced motion keeps a visible stationary indeterminate connection indicator", async ({ page, isMobile }) => {
  test.skip(isMobile, "The native splash is a desktop surface.");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent('<progress class="progress" aria-label="Connection progress"></progress>');
  await page.addStyleTag({ path: resolve("../desktop/splash/style.css") });
  const indicator = page.getByRole("progressbar", { name: "Connection progress" });
  await expect(indicator).toBeVisible();
  await expect(indicator).not.toHaveAttribute("value");
  await expect(indicator).toHaveCSS("height", "3px");
  await expect(indicator).toHaveCSS("background-image", /linear-gradient/);
  await expect(indicator).toHaveCSS("animation-name", "none");
});
