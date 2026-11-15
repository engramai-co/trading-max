import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parityCases } from "./cases";

const fixture = new URL("../../../../../backend/tests/fixtures/portfolio_math/typescript.json", import.meta.url);
const regenerate = "UPDATE_PORTFOLIO_PARITY=1 npm --prefix apps/web test -- lib/portfolio/parity";

function stringify(value: unknown) {
  return JSON.stringify(value, (_, item: unknown) => {
    if (typeof item !== "number") return item;
    if (Object.is(item, -0)) return { $js: "-0" };
    return Number.isFinite(item) ? item : { $js: String(item) };
  });
}

test("Python portfolio math fixtures match the TypeScript source", () => {
  const cases = parityCases();
  // One case per line keeps Git diffs local to the affected scenarios. Timeline
  // geometry is losslessly compacted before serialization.
  const generated = "[\n" + cases.map((item) => "  " + stringify(item)).join(",\n") + "\n]\n";
  if (process.env.UPDATE_PORTFOLIO_PARITY === "1") writeFileSync(fixture, generated);
  const saved = readFileSync(fixture, "utf8");
  if (saved !== generated) {
    const savedCases = new Map((JSON.parse(saved) as typeof cases).map((item) => [
      JSON.stringify([item.function, item.name]), JSON.stringify(item),
    ]));
    const changed = cases.filter((item) =>
      savedCases.get(JSON.stringify([item.function, item.name])) !== stringify(item))
      .map((item) => `${item.function}: ${item.name}`);
    expect.fail(`Portfolio parity fixture changed (previously ${savedCases.size} cases, now ${cases.length}).\n`
      + `Changed or added cases: ${changed.join("; ")}\nRegenerate with: ${regenerate}`);
  }
});
