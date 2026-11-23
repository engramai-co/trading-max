import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { securityHeaders } from "./lib/security-headers";

export default function nextConfig(phase: string): NextConfig {
  // Config is evaluated once per build; reuse this exact marker for BUILD_ID
  // and the bundles. Standalone startup uses the serialized build config.
  const buildId = phase === PHASE_PRODUCTION_BUILD ? randomUUID() : "";
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    agentRules: false,
    // Overview is the cold entry. Keep its shared dependencies together when
    // optional chat and chart features introduce additional async chunks.
    experimental: { turbopackChunking: { minChunkSize: 100_000 } },
    allowedDevOrigins: ["127.0.0.1"],
    env: { NEXT_PUBLIC_TRADING_MAX_WEB_BUILD_ID: buildId },
    generateBuildId: () => buildId || null,
    headers: async () => [
      {
        source: "/:path*",
        headers: securityHeaders(isDev),
      },
    ],
    output: "standalone",
    poweredByHeader: false,
  };
}
