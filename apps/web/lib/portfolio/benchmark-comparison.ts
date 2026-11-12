import { numeric } from "@/lib/numeric";
import type { BenchmarkPricePoint, NavPoint } from "@/lib/types";
import { navNumber, type Scope } from "./nav";

const day = (point: Pick<NavPoint, "date">) => point.date.slice(0, 10);

/** Every compared series uses the same dates. With no match, keep the portfolio's full selected period. */
export function benchmarkComparison(
  points: NavPoint[],
  scope: Scope,
  series: Record<string, BenchmarkPricePoint[]> | undefined,
  names: readonly string[],
) {
  const portfolio = points.filter((point) => navNumber(point, scope, "Twr") != null);
  const benchmarks = names.map((name) => ({
    name,
    // Older fixture histories used price instead of close.
    prices: new Map((series?.[name] ?? []).map((point) => [
      day(point), numeric(point.close ?? (point as BenchmarkPricePoint & { price?: number }).price),
    ])),
  }));
  const priced = (prices: Map<string, number | null>, point: NavPoint) => (prices.get(day(point)) ?? 0) > 0;
  const usable = benchmarks.filter(({ prices }) => portfolio.filter((point) => priced(prices, point)).length > 1);
  const shared = usable.length ? portfolio.filter((point) => usable.every(({ prices }) => priced(prices, point))) : [];

  if (shared.length < 2) return { points: portfolio, comparisons: [], missing: names.length > 0 };

  return {
    points: shared,
    comparisons: usable.map(({ name, prices }) => {
      const start = prices.get(day(shared[0]))!;
      return { name, values: shared.map((point) => prices.get(day(point))! / start - 1) };
    }),
    missing: usable.length < names.length,
  };
}
