import { describe, expect, it } from "vitest";
import cases from "./company-profile.fixture.json";
import { profileSentences, sentenceId } from "./company-profile";
import { businessExcerpt } from "./research-overview";

describe("company description sentences", () => {
  it.each(cases.map((c) => [c.text, c] as const))("split %j as the API does", (_text, expected) => {
    const sentences = profileSentences(expected.text);
    expect(sentences).toEqual(expected.sentences);
    expect(sentences.map(sentenceId)).toEqual(expected.ids);
  });

  it("handles empty, whitespace-only, and normalized whitespace inputs", () => {
    expect(profileSentences("")).toEqual([]);
    expect(profileSentences("   \n\t  ")).toEqual([]);
    expect(profileSentences("  First. \n\t Second?\r\n  Third!  ")).toEqual([
      "First.",
      "Second?",
      "Third!",
    ]);
  });

  it("does not split on abbreviations or initials before capitalized words or digits", () => {
    expect(
      profileSentences("Dr. Smith met Mr. Jones and Mrs. Brown in St. Louis. Next stop!"),
    ).toEqual([
      "Dr. Smith met Mr. Jones and Mrs. Brown in St. Louis.",
      "Next stop!",
    ]);
    expect(
      profileSentences("Acme Ltd. And Beta Plc. Operates with Bros. Group since Dec. 2024. Now it grows."),
    ).toEqual([
      "Acme Ltd. And Beta Plc. Operates with Bros. Group since Dec. 2024.",
      "Now it grows.",
    ]);
    expect(
      profileSentences("Founded by J. P. Morgan (U.S. Corp. Unit) in Mt. Hood. Revenue doubled."),
    ).toEqual([
      "Founded by J. P. Morgan (U.S. Corp. Unit) in Mt. Hood.",
      "Revenue doubled.",
    ]);
  });

  it("pins punctuation, wrapper, lowercase, and UTF-8 fingerprint boundaries", () => {
    expect(
      profileSentences("Wait... Next! Really?! Yes. “Smart” quotes work. 2026 starts now."),
    ).toEqual([
      "Wait...",
      "Next!",
      "Really?!",
      "Yes.",
      "“Smart” quotes work.",
      "2026 starts now.",
    ]);
    expect(
      profileSentences('He said "Hi." next came e.g. something else. Then it ended.'),
    ).toEqual([
      'He said "Hi." next came e.g. something else.',
      "Then it ended.",
    ]);

    const utf8 = profileSentences("Café — résumé. Second sentence.");
    expect(utf8).toEqual(["Café — résumé.", "Second sentence."]);
    expect(utf8.map(sentenceId)).toEqual(["a481bc6e", "a129e0e0"]);
  });
});

describe("company overview excerpt", () => {
  it("keeps empty, single-sentence, and two-sentence summaries intact", () => {
    expect(businessExcerpt("")).toBe("");
    expect(businessExcerpt("Single sentence without period")).toBe("Single sentence without period");
    expect(businessExcerpt("Single sentence.")).toBe("Single sentence.");
    expect(businessExcerpt("First sentence. Second sentence.")).toBe("First sentence. Second sentence.");
  });

  it("truncates to the first two period-delimited sentences followed by an uppercase letter", () => {
    const summary = cases[0].text;
    const excerpt = businessExcerpt(summary);
    expect(excerpt).toBe(
      "Synthetic Issuer Inc. designs and sells synthetic widgets in 12 markets. The company also offers Widget Cloud, a subscription service.",
    );
    expect(excerpt.length).toBeLessThan(summary.length);
  });

  it("matches lookbehind split semantics on non-period punctuation, lowercase, digits, double dots, and spacing", () => {
    expect(businessExcerpt("First! Second? Third. Fourth.")).toBe("First! Second? Third. Fourth.");
    expect(businessExcerpt("First. second. Third. Fourth.")).toBe("First. second. Third.");
    expect(businessExcerpt("First. 2026 starts. Third. Fourth.")).toBe("First. 2026 starts. Third.");
    expect(businessExcerpt('First. "Quoted" Second. Third.')).toBe('First. "Quoted" Second. Third.');
    expect(businessExcerpt("A.. B. C.")).toBe("A.. B.");
    expect(businessExcerpt("First.\n  Second. Third.")).toBe("First. Second.");
  });
});
