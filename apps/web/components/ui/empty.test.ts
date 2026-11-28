import { createElement as el } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { EmptyTitle } from "./empty";

test("EmptyTitle defaults to h3 and accepts an explicit h2", () => {
  expect(renderToStaticMarkup(el(EmptyTitle, null, "No positions"))).toBe('<h3 data-slot="empty-title">No positions</h3>');
  expect(renderToStaticMarkup(el(EmptyTitle, { as: "h2" }, "No positions"))).toBe('<h2 data-slot="empty-title">No positions</h2>');
});
