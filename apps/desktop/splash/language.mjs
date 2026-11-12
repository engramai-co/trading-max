export const defaultLanguage = "zh-CN";

export function translate(language, zh, en) {
  return language === "en" ? en : zh;
}

// Bundled markup carries Chinese text and English alternatives. Keep the
// original text so a switch back does not require reloading any open forms.
export function pageLanguage(document) {
  const entries = [];
  for (const node of document.querySelectorAll("[data-en]")) {
    entries.push([value => { node.textContent = value; }, node.textContent, node.dataset.en]);
  }
  for (const attribute of ["aria-label", "placeholder", "value"]) {
    for (const node of document.querySelectorAll("[data-en-" + attribute + "]")) {
      entries.push([value => node.setAttribute(attribute, value), node.getAttribute(attribute),
        node.getAttribute("data-en-" + attribute)]);
    }
  }

  let language = defaultLanguage;
  return {
    get value() { return language; },
    t: (zh, en) => translate(language, zh, en),
    apply(choice) {
      const next = choice === "en" ? choice : defaultLanguage;
      if (next === language) return false;
      language = next;
      document.documentElement.lang = language;
      for (const [write, zh, en] of entries) write(translate(language, zh, en));
      return true;
    },
  };
}
