import { ApiError, number, numeric, type ApiValidationIssue } from "./data";

type Copy = (zh: string, en: string) => string;
export const scenarioKeys = ["bear", "base", "bull"] as const;
const scenarioNames = {
  bear: ["保守情景", "Bear case"],
  base: ["基准情景", "Base case"],
  bull: ["乐观情景", "Bull case"],
} as const;
export function scenarioLabel(key: typeof scenarioKeys[number], t: Copy) {
  return t(scenarioNames[key][0], scenarioNames[key][1]);
}
// Editor, history and validation messages use the same names and display units.
export const assumptionFields = [
  { key: "revenueCagr", label: ["营收增长", "Revenue CAGR"], percent: true, min: -99, max: 500 },
  { key: "targetFcfMargin", label: ["现金流率", "FCF margin"], percent: true, min: -100, max: 100 },
  { key: "discountRate", label: ["折现率", "Discount rate"], percent: true, min: 0.1, max: 100 },
  { key: "exitFcfMultiple", label: ["退出倍数", "Exit multiple"], percent: false, min: 0, max: 300 },
  { key: "shareCagr", label: ["股数增长", "Share CAGR"], percent: true, min: -99, max: 100 },
] as const;
function assumptionAt(key: string) {
  const [scenario, fieldKey, extra] = key.split(".");
  const field = assumptionFields.find((item) => item.key === fieldKey);
  return !extra && field && scenarioKeys.some((item) => item === scenario)
    ? { field, scenario: scenario as typeof scenarioKeys[number] }
    : null;
}
export function assumptionValue(value: unknown, percent: boolean, t: Copy) {
  const n = numeric(value);
  return n == null ? t("未设置", "Not set") : number(n * (percent ? 100 : 1)) + (percent ? "%" : "×");
}
export function assumptionChange(key: string, before: unknown, after: unknown, t: Copy) {
  const item = assumptionAt(key);
  if (!item) return t("其他假设已修改", "Other assumptions changed");
  return `${scenarioLabel(item.scenario, t)} · ${t(item.field.label[0], item.field.label[1])}${t("：", ": ")}${assumptionValue(before, item.field.percent, t)} → ${assumptionValue(after, item.field.percent, t)}`;
}
function validationReason(issue: ApiValidationIssue, percent: boolean, t: Copy) {
  const bounds = [
    ["greater_than", "gt", "需大于", "Must be greater than"],
    ["greater_than_equal", "ge", "需不小于", "Must be at least"],
    ["less_than", "lt", "需小于", "Must be less than"],
    ["less_than_equal", "le", "需不大于", "Must be at most"],
  ] as const;
  for (const [type, key, zh, en] of bounds) {
    if (issue.type === type && issue.bounds[key] != null)
      return t(zh, en) + " " + assumptionValue(issue.bounds[key], percent, t);
  }
  if (["float_parsing", "float_type", "finite_number", "int_parsing", "int_type"].includes(issue.type))
    return t("请输入有效数字", "Enter a valid number");
  if (issue.type === "missing") return t("请填写此项", "This field is required");
  return t("此值未通过校验，请检查后重试", "This value was rejected. Check it and retry");
}
export function assumptionErrors(error: unknown, t: Copy) {
  const fields: Record<string, string> = {};
  if (error instanceof ApiError) {
    for (const issue of error.issues) {
      const path = issue.path[0] === "body" ? issue.path.slice(1) : issue.path;
      if (path[0] !== "scenarios") continue;
      const key = path.slice(1).join(".");
      const item = assumptionAt(key);
      if (item) fields[key] = validationReason(issue, item.field.percent, t);
    }
  }
  const message = Object.keys(fields).length
    ? t("假设未保存，请修改标出的项目后重试。", "Assumptions were not saved. Correct the marked fields and retry.")
    : error instanceof ApiError && [400, 422].includes(error.status)
      ? t("假设未通过校验。请检查填写的数值后重试，修改仍保留在此处。", "Assumptions were rejected. Check the entered values and retry. Your edits are preserved.")
      : t("暂时无法保存假设，请重试。修改仍保留在此处。", "Could not save assumptions. Please retry. Your edits are preserved.");
  return { fields, message };
}
