import { describe, expect, it } from "vitest";
import cases from "./company-profile.fixture.json";
import { profileSentences, sentenceId } from "./company-profile";

describe("company description sentences", () => {
  it.each(cases.map((c) => [c.text, c] as const))("split %j as the API does", (_text, expected) => {
    const sentences = profileSentences(expected.text);
    expect(sentences).toEqual(expected.sentences);
    expect(sentences.map(sentenceId)).toEqual(expected.ids);
  });
});
