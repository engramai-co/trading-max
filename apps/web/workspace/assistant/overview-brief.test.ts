import { describe, expect, it } from "vitest";
import { overviewBriefHeadline } from "./overview-brief";

describe("overview brief scope header", () => {
  it("shows the timestamp alone when all investment accounts are selected", () => {
    expect(
      overviewBriefHeadline({
        scope: "total",
        objectLabel: "All investment accounts",
        asOfLabel: "As of 30 Jan, 20:00",
      }),
    ).toBe("As of 30 Jan, 20:00");
    expect(
      overviewBriefHeadline({
        scope: "total",
        objectLabel: "全部投资账户",
        asOfLabel: "截至 1月30日 20:00",
      }),
    ).toBe("截至 1月30日 20:00");
  });

  it.each(["invest", "isa"] as const)(
    "labels the all-account scope alongside the timestamp when %s is selected",
    (scope) => {
      expect(
        overviewBriefHeadline({
          scope,
          objectLabel: "All investment accounts",
          asOfLabel: "As of 30 Jan, 20:00",
        }),
      ).toBe("All investment accounts · As of 30 Jan, 20:00");
      expect(
        overviewBriefHeadline({
          scope,
          objectLabel: "全部投资账户",
          asOfLabel: "截至 1月30日 20:00",
        }),
      ).toBe("全部投资账户 · 截至 1月30日 20:00");
    },
  );

  it.each(["total", "invest", "isa"] as const)(
    "falls back to the scope label when no brief timestamp exists (%s)",
    (scope) => {
      expect(
        overviewBriefHeadline({
          scope,
          objectLabel: "All investment accounts",
          asOfLabel: null,
        }),
      ).toBe("All investment accounts");
      expect(
        overviewBriefHeadline({
          scope,
          objectLabel: "全部投资账户",
        }),
      ).toBe("全部投资账户");
    },
  );
});
