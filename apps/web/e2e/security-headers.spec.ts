import { expect, test } from "@playwright/test";
import { contentSecurityPolicy, securityHeaders } from "../lib/security-headers";

type CspViolation = {
  blockedURI: string;
  effectiveDirective: string;
  violatedDirective: string;
};

type CspWindow = Window & {
  __cspViolations?: CspViolation[];
};

test.describe("security headers", () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.",
  );

  test("applies baseline security headers and hydrates the overview without CSP violations", async ({
    page,
    request,
  }) => {
    for (const path of ["/", "/api/backend/health"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const headers = response.headers();
      for (const { key, value } of securityHeaders()) {
        const actual = headers[key.toLowerCase()];
        if (key === "Content-Security-Policy") {
          expect(actual, `${path} ${key}`).toContain("frame-ancestors 'none'");
          expect(actual, `${path} ${key}`).toContain("frame-src 'none'");
          expect(
            [contentSecurityPolicy(false), contentSecurityPolicy(true)],
            `${path} ${key}`,
          ).toContain(actual);
        } else {
          expect(actual, `${path} ${key}`).toBe(value);
        }
      }
    }

    const consoleCspErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /content[- ]security[- ]policy/i.test(message.text())
      ) {
        consoleCspErrors.push(message.text());
      }
    });
    await page.addInitScript(() => {
      const violations: CspViolation[] = [];
      (window as CspWindow).__cspViolations = violations;
      document.addEventListener(
        "securitypolicyviolation",
        (event) => {
          violations.push({
            blockedURI: event.blockedURI,
            effectiveDirective: event.effectiveDirective,
            violatedDirective: event.violatedDirective,
          });
        },
        true,
      );
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.locator("main :is(.mx-loading, [aria-busy=true])"),
    ).toHaveCount(0);

    const violations = await page.evaluate(
      () => (window as CspWindow).__cspViolations,
    );
    expect(violations).toEqual([]);
    expect(consoleCspErrors).toEqual([]);
  });
});
