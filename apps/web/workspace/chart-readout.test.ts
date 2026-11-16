import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readingHtml, readingText, type Reading } from "./chart-readout";
import { ReadingView } from "./reading-card";

const money: Reading = {
  time: "23 Sept, 12:50",
  primary: { label: "Period net P&L", value: "+£20,873.83", tone: "up", detail: "+9.62% vs opening" },
  groups: [
    [{ label: "P&L drawdown", value: "−£954.53", tone: "down", detail: "−0.44%" }],
    [
      { label: "Account value", value: "£237,863", key: { colour: "#17191c" } },
      { label: "Net deposits", value: "£186,632", key: { colour: "#536176", dashed: true } },
    ],
  ],
};
const candle: Reading = {
  time: "8 Oct",
  ohlc: { close: "340.42", change: "+3.53 · +1.05%", tone: "up", open: "336.82", high: "341.57", low: "335.90", volume: "34.40M" },
  groups: [[
    { label: "SMA20", value: "331.35", key: { colour: "#17191c" } },
    { label: "SMA50", value: "322.01", key: { colour: "#536176", dashed: true } },
    { label: "SMA200", value: "288.23", key: { colour: "#17191c", dotted: true } },
    { label: "RSI 14", value: "54.39" },
    { label: "MACD", value: "4.735" },
  ]],
};

const card = (reading: Reading, locale: "zh" | "en" = "en", variant: "card" | "strip" = "card") =>
  renderToStaticMarkup(createElement(ReadingView, { reading, locale, variant }));

describe("reading card", () => {
  it("renders the same DOM as the ECharts HTML tooltip", () => {
    for (const reading of [money, candle, { time: "No data · 00:00–01:40" }, { time: "13 Nov", flag: "Estimate", primary: { value: "7,500.58" } }])
      for (const locale of ["zh", "en"] as const)
        expect(readingHtml(reading, locale)).toBe(card(reading, locale));
  });

  it("leads with one figure, keys series rows and keeps tone on signed results", () => {
    const html = card(money);
    expect(html).toContain('<div class="mx-reading-primary" data-tone="up"><span class="mx-reading-label">Period net P&amp;L</span><span class="mx-reading-value">+£20,873.83</span><span class="mx-reading-detail">+9.62% vs opening</span></div>');
    expect(html).toContain('<i class="mx-reading-key" data-dashed="" style="--key:#536176" aria-hidden="true"></i>Net deposits');
    expect(html).toContain('<dd data-tone="down">−£954.53<span class="mx-reading-detail">−0.44%</span></dd>');
    expect(html).not.toContain("GBP");
  });

  it("folds rows past the card and strip limits into a count", () => {
    expect(card(money).match(/mx-reading-row/g)).toHaveLength(3);
    expect(card(money, "en", "strip").match(/mx-reading-row/g)).toHaveLength(2);
    expect(card(money, "zh", "strip")).toContain('<div class="mx-reading-more">另 1 项</div>');
    expect(card({ ...money, more: 2 })).toContain('<div class="mx-reading-more">2 more</div>');
  });

  it("gives a strip without a primary one more row in the primary's place", () => {
    const rows = ["Buy", "Hold", "Sell", "Other"].map((label, index) => ({ label, value: String(index) }));
    const plain: Reading = { time: "Current", groups: [rows.slice(0, 3)] };
    expect(card(plain, "en", "strip").match(/mx-reading-row/g)).toHaveLength(3);
    expect(card(plain, "en", "strip")).not.toContain("mx-reading-more");
    expect(card({ ...plain, groups: [rows] }, "en", "strip")).toContain('<div class="mx-reading-more">1 more</div>');
    expect(card({ ...plain, groups: [rows] }).match(/mx-reading-row/g)).toHaveLength(3);
  });

  it("speaks every row in full when the card summarises them", () => {
    const summary: Reading = {
      time: "Current",
      groups: [[{ label: "Buy", value: "24", detail: "incl. 9 strong buy" }, { label: "Hold", value: "12" }]],
      spoken: [[{ label: "Strong buy", value: "9" }, { label: "Buy", value: "15" }, { label: "Hold", value: "12" }]],
    };
    expect(readingText(summary, "en")).toBe("Current\nStrong buy 9\nBuy 15\nHold 12");
    expect(card(summary)).toContain('<dd>24<span class="mx-reading-detail">incl. 9 strong buy</span></dd>');
    expect(card(summary)).not.toContain("Strong buy 9");
  });

  it("puts the close first and the other prices in a grid, with up to four indicator cells", () => {
    const html = card(candle, "zh");
    expect(html).toContain('<div class="mx-reading-primary"><span class="mx-reading-label">收</span><span class="mx-reading-value">340.42</span><span class="mx-reading-detail" data-tone="up">+3.53 · +1.05%</span></div>');
    expect(html).toContain('<dl class="mx-reading-ohlc">');
    expect(html.match(/<dl class="mx-reading-group" data-columns="2">/g)).toHaveLength(1);
    expect(html).toContain('<div class="mx-reading-more">另 1 项</div>');
    expect(card(candle, "en", "strip")).not.toContain("SMA20");
  });

  it("draws each key with its line's own stroke", () => {
    const html = card(candle);
    expect(html).toContain('<i class="mx-reading-key" style="--key:#17191c" aria-hidden="true"></i>SMA20');
    expect(html).toContain('<i class="mx-reading-key" data-dashed="" style="--key:#536176" aria-hidden="true"></i>SMA50');
    expect(html).toContain('<i class="mx-reading-key" data-dotted="" style="--key:#17191c" aria-hidden="true"></i>SMA200');
  });

  it("escapes provider text and drops anything but a colour from the key", () => {
    const html = readingHtml({
      time: "<img src=x onerror=alert(1)>",
      flag: "\"quoted\"",
      primary: { label: "A & B", value: "'1'", key: { colour: "red\" onmouseover=\"alert(1)" } },
      groups: [[{ label: "Line", value: "1", key: { colour: "#1768e5;background:url(x)" } }, { label: "Var", value: "2", key: { colour: "var(--mx-ink)" } }]],
    }, "en");
    expect(html).not.toMatch(/<img|" onmouseover|background:url/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("&#x27;1&#x27;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain('<i class="mx-reading-key" aria-hidden="true"></i>A &amp; B');
    expect(html).toContain('style="--key:var(--mx-ink)"');
  });
});

describe("readingText", () => {
  it("reads the time, the figures and the exception word once, without sources", () => {
    expect(readingText({ ...money, flag: "Estimate" }, "en")).toBe([
      "23 Sept, 12:50",
      "Period net P&L +£20,873.83 +9.62% vs opening",
      "P&L drawdown −£954.53 −0.44%",
      "Account value £237,863",
      "Net deposits £186,632",
      "Estimate",
    ].join("\n"));
  });

  it("spells out every candle field, including rows the card folds away", () => {
    expect(readingText(candle, "zh").split("\n")).toEqual([
      "8 Oct", "收 340.42 +3.53 · +1.05%", "开 336.82", "高 341.57", "低 335.90", "量 34.40M",
      "SMA20 331.35", "SMA50 322.01", "SMA200 288.23", "RSI 14 54.39", "MACD 4.735",
    ]);
    expect(readingText({ time: "No data · 00:00–01:40" }, "en")).toBe("No data · 00:00–01:40");
  });
});

