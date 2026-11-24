import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("joins conditional class names and skips falsy inputs", () => {
    expect(cn("mx-panel", false && "hidden", undefined, null, "mx-active")).toBe("mx-panel mx-active");
  });

  it("merges conflicting Tailwind utility classes in favor of later arguments", () => {
    expect(cn("px-2 py-1 text-sm", "px-4 text-base")).toBe("py-1 px-4 text-base");
  });
});
