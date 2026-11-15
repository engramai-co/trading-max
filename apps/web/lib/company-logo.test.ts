import { describe, expect, it } from "vitest";
import { logoCandidates, safeIsin } from "./company-logo";

describe("company logo sources", () => {
  it("tries a valid ISIN before the ticker and the site icon", () => {
    expect(logoCandidates("SEMI", safeIsin("ie000i8krll9"), "example.com")).toEqual([
      "https://assets.parqet.com/logos/isin/IE000I8KRLL9",
      "https://assets.parqet.com/logos/symbol/SEMI",
      "https://www.google.com/s2/favicons?domain=example.com&sz=128",
    ]);
  });

  it("ignores a malformed ISIN", () => {
    expect(safeIsin("IE000I8KRLL")).toBeNull();
    expect(safeIsin("../etc/passwd")).toBeNull();
    expect(logoCandidates("AAPL", safeIsin("not-an-isin"))).toEqual(["https://assets.parqet.com/logos/symbol/AAPL"]);
  });
});
