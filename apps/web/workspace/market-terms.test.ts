import { describe, expect, it } from "vitest";
import { filingLabel, ratingLabel } from "./market-terms";

const zh = (chinese: string) => chinese;
const en = (_zh: string, english: string) => english;

describe("market terms", () => {
  it("names analyst ratings in Chinese whatever their spelling", () => {
    expect(ratingLabel("Outperform", zh)).toBe("跑赢大盘");
    expect(ratingLabel("Market Perform", zh)).toBe("与大盘持平");
    expect(ratingLabel("Equal-Weight", zh)).toBe("同步大市");
    expect(ratingLabel("equal weight", zh)).toBe("同步大市");
    expect(ratingLabel(" Strong_Buy ", zh)).toBe("强烈买入");
  });

  it("keeps the provider's rating in English and unknown ratings as they are", () => {
    expect(ratingLabel("Outperform", en)).toBe("Outperform");
    expect(ratingLabel("Conviction List", zh)).toBe("Conviction List");
  });

  it("names filing forms, including amendments and prospectuses", () => {
    expect(filingLabel("8-K", zh)).toBe("重大事项公告");
    expect(filingLabel("10-q", zh)).toBe("季报");
    expect(filingLabel("10-K/A", zh)).toBe("年报（修订）");
    expect(filingLabel("424B5", zh)).toBe("招股说明书");
    expect(filingLabel("SC 13G/A", zh)).toBe("持股披露（修订）");
    expect(filingLabel("10-Q", en)).toBe("10-Q");
    expect(filingLabel("N-CSR", zh)).toBe("N-CSR");
  });
});
