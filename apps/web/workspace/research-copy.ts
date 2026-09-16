type Copy = (zh: string, en: string) => string;

/** Translate system-authored templates while retaining their observed values. */
export function researchText(value: string, t: Copy) {
  const rules: Array<[RegExp, string]> = [
    [/^(.+) earnings calendar refresh$/, t("$1 财报日历更新", "$1 earnings calendar refresh")],
    [/^(.+) earnings & guidance refresh$/, t("$1 财报与业绩指引更新", "$1 earnings & guidance refresh")],
    [/^Technical structure is weak$/, t("技术走势偏弱", "Technical structure is weak")],
    [/^Technical momentum is strong$/, t("技术动量偏强", "Technical momentum is strong")],
    [/^Technical score is ([\d.]+)\/100\.$/, t("技术评分 $1/100。", "Technical score is $1/100.")],
    [/^Valuation downside exceeds 15%$/, t("模型下行空间超过 15%", "Valuation downside exceeds 15%")],
    [/^Valuation margin exceeds 25%$/, t("模型上行空间超过 25%", "Valuation margin exceeds 25%")],
    [/^EV10 indicates (.+) downside\.$/, t("十年模型下行空间 $1。", "EV10 indicates $1 downside.")],
    [/^EV10 indicates (.+) upside\.$/, t("十年模型上行空间 $1。", "EV10 indicates $1 upside.")],
    [/^Price below bear-case value$/, t("现价低于保守情景估值", "Price below bear-case value")],
    [/^Price above bull-case value$/, t("现价高于乐观情景估值", "Price above bull-case value")],
    [/^Spot is (.+) below the bear-case scenario value\.$/, t("现价较保守情景估值低 $1。", "Spot is $1 below the bear-case scenario value.")],
    [/^Spot is (.+) above the bull-case scenario value\.$/, t("现价较乐观情景估值高 $1。", "Spot is $1 above the bull-case scenario value.")],
    [/^Held position is below 20D support$/, t("持仓价格低于 20 日支撑", "Held position is below 20D support")],
    [/^Held position is near 20D support$/, t("持仓价格接近 20 日支撑", "Held position is near 20D support")],
    [/^Held position is near 20D resistance$/, t("持仓价格接近 20 日阻力", "Held position is near 20D resistance")],
    [/^Held position is below SMA 200$/, t("持仓价格低于 200 日均线", "Held position is below SMA 200")],
    [/^(.+) is at (.+), below the 20D support at (.+)\.$/, t("$1 现价 $2，低于 20 日支撑 $3。", "$1 is at $2, below the 20D support at $3.")],
    [/^(.+) is (.+) from the 20d support at (.+)\.$/, t("$1 距离 20 日支撑 $3 为 $2。", "$1 is $2 from the 20d support at $3.")],
    [/^(.+) is (.+) from the 20d resistance at (.+)\.$/, t("$1 距离 20 日阻力 $3 为 $2。", "$1 is $2 from the 20d resistance at $3.")],
    [/^(.+) is at (.+); SMA 200 is (.+)\.$/, t("$1 现价 $2；200 日均线为 $3。", "$1 is at $2; SMA 200 is $3.")],
    [/^Single-name exposure exceeds 10%$/, t("单一证券敞口超过 10%", "Single-name exposure exceeds 10%")],
    [/^Look-through exposure is (.+) of the portfolio\.$/, t("穿透敞口占组合的 $1。", "Look-through exposure is $1 of the portfolio.")],
    [/^Spot is near the call wall$/, t("现价接近看涨持仓墙", "Spot is near the call wall")],
    [/^Spot is near the put wall$/, t("现价接近看跌持仓墙", "Spot is near the put wall")],
    [/^Spot (.+) is (.+) from the call wall at (.+)\.$/, t("现价 $1 距离看涨持仓墙 $3 为 $2。", "Spot $1 is $2 from the call wall at $3.")],
    [/^Spot (.+) is (.+) from the put wall at (.+)\.$/, t("现价 $1 距离看跌持仓墙 $3 为 $2。", "Spot $1 is $2 from the put wall at $3.")],
    [/^(Market|Technical|Options|Valuation) data is stale$/, t("研究数据已过期", "$1 data is stale")],
    [/^The latest (.+) observation is (.+) days old\.$/, t("最近一次数据更新距今 $2 天。", "The latest $1 observation is $2 days old.")],
  ];
  const rule = rules.find(([pattern]) => pattern.test(value));
  return rule ? value.replace(rule[0], rule[1]) : value;
}
