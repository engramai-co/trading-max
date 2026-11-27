import { expect, type Locator } from "@playwright/test";

export async function tapRecordsBottom(trigger: Locator) {
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.evaluate((button) => button.scrollIntoView({ block: "center", behavior: "instant" }));
  const { x, y, width, height, hits } = await trigger.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    return {
      x, y: rect.bottom - 2, width: rect.width, height: rect.height,
      hits: [10, 5, 2].map((offset) => button.contains(document.elementFromPoint(x, rect.bottom - offset))),
    };
  });
  expect(width).toBeGreaterThanOrEqual(44);
  expect(height).toBeGreaterThanOrEqual(44);
  expect(hits).toEqual([true, true, true]);
  await trigger.page().touchscreen.tap(x, y);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}
