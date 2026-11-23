export type SecurityHeader = {
  key: string;
  value: string;
};

/**
 * Baseline Content-Security-Policy for HTML pages and API routes without nonces.
 * Local desktop and preview servers run on loopback HTTP, so HTTPS-only controls
 * (HSTS, upgrade-insecure-requests) belong on configured HTTPS ingress instead.
 */
export function contentSecurityPolicy(development = false): string {
  const directives = [
    // Restrict unlisted fetch directives (manifest, media, workers) to same origin.
    "default-src 'self'",
    // Next.js 16 App Router emits inline RSC bootstrap scripts and Mantine renders
    // an inline ColorSchemeScript without nonces; eval is restricted to dev tooling.
    // The macOS desktop App injects its overlay marker via WKUserScript outside page CSP.
    development
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'",
    // Mantine runtime styles, React inline style props, and ECharts HTML tooltips.
    "style-src 'self' 'unsafe-inline'",
    // Local brand/texture assets, the same-origin /api/company-logo/[ticker] server
    // proxy, data: URIs for chart PNG export (chart.getDataURL), and blob: images.
    "img-src 'self' data: blob:",
    // System font stacks only; permit local or data-inlined fonts without external CDNs.
    "font-src 'self' data:",
    // All browser fetches (/api/backend/* JSON and SSE assistant streams, Next.js RSC
    // navigations, and dev HMR sockets) stay on the same origin.
    "connect-src 'self'",
    // Neither web pages nor desktop auxiliary windows embed iframes.
    "frame-src 'none'",
    // Block clickjacking (the desktop App loads pages in top-level WKWebView windows).
    "frame-ancestors 'none'",
    // Prevent injected <base> tags from retargeting relative URLs.
    "base-uri 'self'",
    // Restrict HTML form submissions to the current origin.
    "form-action 'self'",
    // Disable legacy plugin elements (<object>, <embed>, <applet>).
    "object-src 'none'",
  ];
  return directives.join("; ");
}

/** Baseline security response headers applied to all Next.js routes. */
export function securityHeaders(development = false): SecurityHeader[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(development) },
    // Legacy clickjacking protection paired with CSP frame-ancestors 'none'.
    { key: "X-Frame-Options", value: "DENY" },
    // Keep same-origin paths, send origin only across HTTPS origins, omit on downgrade.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Prevent MIME sniffing across HTML pages, JSON APIs, and /api/company-logo responses.
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Disable unused sensor/location APIs while keeping clipboard-write available
    // for chart reading copy and OAuth device-code copy.
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
}
