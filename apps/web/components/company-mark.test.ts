import { describe, expect, it } from "vitest";

import { companyLogoSources } from "@/components/company-mark";

describe("companyLogoSources", () => {
  it("uses the canonical ticker logo without requiring fundamentals", () => {
    expect(companyLogoSources(" be ")).toEqual([
      "/api/company-logo/BE",
    ]);
  });

  it("falls back to a high-resolution domain favicon when available", () => {
    expect(
      companyLogoSources("VRT", "https://www.vertiv.com/en-us/about/"),
    ).toEqual([
      "/api/company-logo/VRT?domain=vertiv.com",
    ]);
  });

  it("does not emit a malformed fallback for an invalid website", () => {
    expect(companyLogoSources("GOOGL", "https://")).toEqual([
      "/api/company-logo/GOOGL",
    ]);
  });
});
