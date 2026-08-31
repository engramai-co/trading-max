import { describe, expect, it } from "vitest";

import { catalogues, en, zh } from "@/lib/i18n/messages";

type Leaf = string;
type Node = { [key: string]: Leaf | Node };

function flatten(node: Node, prefix = ""): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      output[path] = value;
    } else {
      Object.assign(output, flatten(value, path));
    }
  }
  return output;
}

describe("message catalogues", () => {
  const flatZh = flatten(zh as unknown as Node);
  const flatEn = flatten(en as unknown as Node);

  it("exposes both locales", () => {
    expect(Object.keys(catalogues).sort()).toEqual(["en", "zh"]);
  });

  it("covers identical keys in both locales", () => {
    expect(Object.keys(flatEn).sort()).toEqual(Object.keys(flatZh).sort());
  });

  it("has no empty translations", () => {
    for (const [key, value] of Object.entries(flatZh)) {
      expect(value.trim(), `zh.${key} is empty`).not.toBe("");
    }
    for (const [key, value] of Object.entries(flatEn)) {
      expect(value.trim(), `en.${key} is empty`).not.toBe("");
    }
  });

  it("does not leave untranslated Chinese in the English catalogue", () => {
    const hanzi = /[\u4e00-\u9fff]/;
    for (const [key, value] of Object.entries(flatEn)) {
      expect(hanzi.test(value), `en.${key} still contains Chinese`).toBe(false);
    }
  });
});
