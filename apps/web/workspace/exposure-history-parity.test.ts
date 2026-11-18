import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { countryCode } from "./exposure-names";

it("groups stored historical countries by the Holdings page's issuer aliases", () => {
  const aliases = JSON.parse(readFileSync(
    new URL("../../../backend/src/trading_max/reference/data/exposure-country-codes.json", import.meta.url),
    "utf8",
  )) as Record<string, string>;
  for (const [label, code] of Object.entries(aliases)) expect(countryCode(label)).toBe(code);
});
