import { filingLabel } from "./market-terms";

type Copy = (zh: string, en: string) => string;

/** SEC EDGAR form descriptions as research shows them. */
const descriptions: Record<string, string> = {
  "periodic financial reports": "定期财务报告",
  "corporate changes & voting matters": "公司变更与投票事项",
  "proxy statements": "股东大会委托书",
  "offering registrations": "发行注册",
  "tender offer/acquisition reports": "要约收购与持股报告",
  "annual report to shareholders": "致股东年报",
  "registration withdrawal request": "撤回注册申请",
  "notice of exempt solicitation": "豁免征集通知",
};
const forms: Record<string, string> = {
  SD: "冲突矿产披露",
  CORRESP: "与 SEC 往来函件",
  "425": "并购相关沟通材料",
  "N-PX": "代理投票记录",
  "25-NSE": "退市通知",
  "11-K": "员工购股计划年报",
  ARS: "致股东年报",
  "S-8": "员工股权计划注册",
};

/** "10-Q · 季报" in Chinese; the provider's own description in English. */
export function filingTitle(form: string, title: string, t: Copy) {
  const code = form.trim();
  const named = filingLabel(code, t);
  const zh =
    named !== code
      ? named
      : (forms[code.toUpperCase()] ?? descriptions[title.trim().toLowerCase()] ?? "");
  const en = title.trim();
  const description = t(zh, en) || en;
  return [code, description].filter(Boolean).join(" · ");
}
