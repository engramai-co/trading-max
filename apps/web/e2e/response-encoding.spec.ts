import { expect, test } from "@playwright/test";

// Next.js compresses route responses itself. A handler that compressed as well
// would reach the browser encoded twice, and its JSON would not parse.
test.describe("data responses", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to a synthetic local deployment.");
  test.skip(({ isMobile }) => isMobile, "Encoding does not depend on the device.");

  test("are encoded once and parse as JSON", async ({ request }) => {
    const headers = { "Accept-Encoding": "gzip, deflate, br" };
    const health = await request.get("/api/backend/health", { headers });
    const { latestRunId } = await health.json() as { latestRunId?: string | null };
    const paths = ["/api/backend/research/shell", "/api/backend/health/details"];
    if (latestRunId) {
      paths.push(`/api/backend/dashboard/history?runId=${encodeURIComponent(latestRunId)}&range=ALL&scope=total`);
    }
    for (const path of paths) {
      const response = await request.get(path, { headers });
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-encoding"] ?? "identity", path).toMatch(/^(gzip|br|deflate|identity)$/);
      await expect(response.json(), path).resolves.toBeTruthy();
    }
  });
});
