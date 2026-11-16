"use client";

import { createElement, type CSSProperties, type ReactElement } from "react";
import { useLocale } from "@/components/locale-provider";
import { readingTree, type Reading, type ReadingLocale, type ReadingNode, type ReadingVariant } from "./chart-readout";

function element(item: ReadingNode): ReactElement {
  const props: Record<string, unknown> = {};
  for (const [name, value] of item.attrs) {
    if (name === "class") props.className = value;
    else if (name === "style") {
      const at = value.indexOf(":");
      props.style = { [value.slice(0, at)]: value.slice(at + 1) } as CSSProperties;
    } else props[name] = value;
  }
  return createElement(item.tag, props, ...item.children.map((child) => typeof child === "string" ? child : element(child)));
}

/** The reading card in a given language; ReadingCard reads the language from the workspace. */
export function ReadingView({ reading, variant = "card", locale }: { reading: Reading; variant?: ReadingVariant; locale: ReadingLocale }) {
  return element(readingTree(reading, variant, locale));
}

/** One chart position: the time, one leading figure and at most a few supporting rows. */
export function ReadingCard({ reading, variant = "card" }: { reading: Reading; variant?: ReadingVariant }) {
  const { locale } = useLocale();
  return <ReadingView reading={reading} variant={variant} locale={locale} />;
}

