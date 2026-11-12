import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  // Config is evaluated once per build; reuse this exact marker for BUILD_ID
  // and the bundles. Standalone startup uses the serialized build config.
  const buildId = phase === PHASE_PRODUCTION_BUILD ? randomUUID() : "";
  return {
    agentRules: false,
    allowedDevOrigins: ["127.0.0.1"],
    env: { NEXT_PUBLIC_TRADING_MAX_WEB_BUILD_ID: buildId },
    generateBuildId: () => buildId || null,
    output: "standalone",
    poweredByHeader: false,
  };
}
