import { describe, expect, it } from "vitest";
import { timelineTooltipCard, type TimelineTooltip } from "./timeline-tooltip";

const content: TimelineTooltip = {
  account: "Invest",
  range: "5D",
  unit: "GBP",
  primary: [
    { label: "Value change", values: [12, -8], percentages: [0.12, -0.08], signed: true },
    { label: "Drawdown", values: [0, -20], percentages: [0, -20 / 112], signed: true },
  ],
  secondary: [
    { label: "Account value", values: [112, 92] },
    { label: "Opening value", values: [100, 100] },
    { label: "Matched reconstruction", values: [111, null], optional: true },
  ],
};

describe("performance tooltip card", () => {
  it("pairs the selected observation's amount and percentage without repeating labels", () => {
    const html = timelineTooltipCard(content, 1, "9 September 2026, 09:30 GMT+1", "Broker observation");
    expect(html).toContain("5D");
    expect(html).toContain("09:30 GMT+1");
    expect(html).toContain('<dd data-tone="down"><span>-£8.00</span><small>-8.00%</small>');
    expect(html).toContain('<dd data-tone="down"><span>-£20.00</span><small>-17.86%</small>');
    expect(html).toContain("£92.00");
    expect(html).not.toContain("£112.00");
    expect(html.match(/Account value/g)).toHaveLength(1);
    expect(html).not.toContain("Matched reconstruction");
    expect(html.indexOf("Broker observation")).toBeGreaterThan(html.indexOf("Opening value"));
  });
  it("keeps zero and missing required values distinct while hiding only missing optional rows", () => {
    const html = timelineTooltipCard(content, 0, "Date");
    expect(html).toContain('<dd data-tone="neutral"><span>£0.00</span><small>0.00%</small>');
    expect(html).toContain("Matched reconstruction");
    const missing = timelineTooltipCard(content, 2, "Date");
    expect(missing).toContain("Account value");
    expect(missing).toContain("—");
    expect(missing).not.toContain("Matched reconstruction");
    expect(missing).not.toContain("NaN");
  });
  it("renders return values as percentages without inventing a GBP amount", () => {
    const html = timelineTooltipCard({ primary: [{ label: "Portfolio TWR", values: [0.075], percentage: true, signed: true }], secondary: [] }, 0, "Date");
    expect(html).toContain('<dd data-tone="up"><span>+7.50%</span>');
    expect(html).not.toContain("£");
  });
  it("escapes account names, labels, timestamps and provider provenance in HTML", () => {
    const unsafe = '<img src=x onerror="alert(1)"> & \'text\'';
    const html = timelineTooltipCard({ account: unsafe, range: unsafe, unit: unsafe, primary: [{ label: unsafe, values: [1] }], secondary: [] }, 0, unsafe, unsafe);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;text&#39;");
  });
});
