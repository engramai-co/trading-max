import { describe, expect, it } from "vitest";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import nextConfig from "../next.config";
import { contentSecurityPolicy, securityHeaders } from "./security-headers";

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const DEVELOPMENT_CSP = PRODUCTION_CSP.replace(
  "script-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
);

describe("baseline security headers", () => {
  it("pins the production header set across all routes", async () => {
    for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) {
      const config = nextConfig(phase);
      expect(config.poweredByHeader).toBe(false);
      const rules = await config.headers?.();
      expect(rules).toEqual([
        {
          source: "/:path*",
          headers: [
            { key: "Content-Security-Policy", value: PRODUCTION_CSP },
            { key: "X-Frame-Options", value: "DENY" },
            { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ],
        },
      ]);
    }
  });

  it("omits unsafe-eval and HTTPS-only directives in production", () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toBe(PRODUCTION_CSP);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(securityHeaders(false).map((header) => header.key)).not.toContain(
      "Strict-Transport-Security",
    );
  });

  it("adds unsafe-eval to script-src only in development", async () => {
    const rules = await nextConfig(PHASE_DEVELOPMENT_SERVER).headers?.();
    expect(rules).toEqual([
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: DEVELOPMENT_CSP },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]);
  });
});
