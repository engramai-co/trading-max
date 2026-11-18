import { describe, expect, it } from "vitest";
import { noticeKinds, noticeLine, shownEvidence, type EvidenceNotice } from "./evidence-notices";

const zh = (a: string) => a;
const en = (_: string, b: string) => b;

const notice: EvidenceNotice = {
  ticker: "SYNT",
  modelId: "saved-version",
  savedAt: "2026-08-03T10:00:00Z",
  items: [
    { key: "statements:ttm:2026-09-30", kind: "statements", periodId: "ttm:2026-09-30" },
    { key: "restated:x", kind: "restatement", periodId: "ttm:2026-06-30" },
    { key: "consensusEps:2027-09-30:USD:1", kind: "estimate", metric: "consensusEps", periodEnd: "2027-09-30",
      currency: "USD", saved: 2.5, current: 2.7, asOf: "2026-11-03T21:00:00Z" },
    { key: "consensusEps:2028-09-30:USD:-2", kind: "estimate", metric: "consensusEps", periodEnd: "2028-09-30",
      currency: "USD", saved: -0.4, current: -0.5, asOf: "2026-11-03T21:00:00Z" },
    { key: "consensusRevenueGrowth:2027-09-30::2", kind: "estimate", metric: "consensusRevenueGrowth",
      periodEnd: "2027-09-30", saved: 0.15, current: 0.19, asOf: "2026-11-01" },
  ],
};

describe("evidence notices", () => {
  it("names each kind of new evidence once", () => {
    expect(noticeKinds(notice, zh)).toBe("新报表、重述、EPS 一致预期、营收增长一致预期");
    expect(noticeKinds(notice, en)).toBe("New statements, Restatement, EPS consensus, Revenue-growth consensus");
  });

  it("reads each piece of evidence with its period and values", () => {
    const [statements, restated, eps, loss, growth] = notice.items;
    expect(noticeLine(statements, zh, "zh")).toMatch(/^新报表 · 过去十二个月 截至 /);
    expect(noticeLine(restated, en, "en")).toMatch(/^Restatement · TTM to 30 Jun/);
    expect(noticeLine(eps, en, "en")).toMatch(/^EPS consensus · FY 30 Sept? 2027 · 2\.50 → 2\.70 USD$/);
    expect(noticeLine(loss, en, "en")).toMatch(/· \u22120\.40 → \u22120\.50 USD$/);
    expect(noticeLine(growth, zh, "zh")).toMatch(/^营收增长一致预期 · 财年 2027年9月30日 · 15\.0% → 19\.0%$/);
  });

  it("settles only the evidence a comparison of the same version shows", () => {
    const keys = notice.items.map((item) => item.key);
    expect(shownEvidence(notice, { modelId: "saved-version", evidenceKeys: keys })).toEqual(notice);
    // A comparison made before newer evidence arrived does not settle it.
    const older = shownEvidence(notice, { modelId: "saved-version", evidenceKeys: [keys[0], "statements:ttm:2026-06-30"] });
    expect(older?.items.map((item) => item.key)).toEqual([keys[0]]);
    expect(shownEvidence(notice, { modelId: "saved-version", evidenceKeys: ["statements:ttm:2026-06-30"] })).toBeUndefined();
    expect(shownEvidence(notice, { modelId: "saved-version" })).toBeUndefined();
    expect(shownEvidence(notice, { modelId: "another-version", evidenceKeys: keys })).toBeUndefined();
    expect(shownEvidence(undefined, { modelId: "saved-version", evidenceKeys: keys })).toBeUndefined();
  });
});
