import type { NavPoint } from "@/lib/types";
import type { ChartLine } from "./charts";
import { navNumber, type Scope } from "@/lib/portfolio/nav";

/** Overview is the first performance layer, including its cash-flow baseline. */
export function portfolioValueLines(
  points: NavPoint[], scope: Scope, t: (zh: string, en: string) => string,
  percentage = false,
): ChartLine[] {
  const opening = navNumber(points[0], scope);
  const openingFlows = navNumber(points[0], scope, "NetContributionsGbp");
  return [
    {
      name: percentage ? t("价值变化", "Value change") : t("账户价值", "Account value"),
      values: points.map((point) => {
        const value = navNumber(point, scope);
        return percentage
          ? opening != null && opening > 0 && value != null ? value / opening - 1 : null
          : value;
      }),
      area: true,
    },
    {
      name: percentage ? t("净入金变化", "Contribution change") : t("累计净入金", "Cumulative net contributions"),
      values: points.map((point) => {
        const flows = navNumber(point, scope, "NetContributionsGbp");
        return percentage
          ? opening != null && opening > 0 && openingFlows != null && flows != null
            ? (flows - openingFlows) / opening : null
          : flows;
      }),
      colour: "accent",
      dashed: true,
      step: "end",
    },
  ];
}
