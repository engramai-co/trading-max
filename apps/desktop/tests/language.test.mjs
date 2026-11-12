import test from "node:test";
import assert from "node:assert/strict";
import { pageLanguage } from "../splash/language.mjs";

test("bundled copy defaults to Chinese and can switch without replacing edited input", () => {
  const text = { textContent: "连接已有服务", dataset: { en: "Connect to an existing service" } };
  const attrs = new Map(Object.entries({
    "aria-label": "工作区", "data-en-aria-label": "Workspace",
    placeholder: "工作区名称", "data-en-placeholder": "Workspace name",
    value: "我的投资记录", "data-en-value": "My investments",
  }));
  const input = {
    value: "Synthetic custom name",
    getAttribute: attr => attrs.get(attr),
    setAttribute: (attr, value) => attrs.set(attr, value),
  };
  const document = {
    documentElement: { lang: "zh-CN" },
    querySelectorAll: selector => selector === "[data-en]" ? [text] : [input],
  };
  const locale = pageLanguage(document);
  assert.equal(locale.value, "zh-CN");
  assert.equal(locale.t("通用", "General"), "通用");
  assert.equal(text.textContent, "连接已有服务");
  assert.equal(locale.apply("en"), true);
  assert.equal(document.documentElement.lang, "en");
  assert.equal(text.textContent, "Connect to an existing service");
  assert.equal(attrs.get("aria-label"), "Workspace");
  assert.equal(attrs.get("placeholder"), "Workspace name");
  assert.equal(attrs.get("value"), "My investments");
  assert.equal(input.value, "Synthetic custom name");
  assert.equal(locale.apply("zh-CN"), true);
  assert.equal(document.documentElement.lang, "zh-CN");
  assert.equal(text.textContent, "连接已有服务");
  assert.equal(attrs.get("value"), "我的投资记录");
  assert.equal(input.value, "Synthetic custom name");
});
