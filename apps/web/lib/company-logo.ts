/** Where a listing's logo can come from, most specific first. */

export function safeTicker(value: string) {
  const ticker = value.trim().toUpperCase();
  return /^[A-Z0-9._-]{1,24}$/.test(ticker) ? ticker : null;
}

export function safeIsin(value: string | null | undefined) {
  const isin = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) ? isin : null;
}

export function safeDomain(value: string | null | undefined) {
  if (!value) return null;
  const domain = value.trim().toLowerCase();
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ? domain
    : null;
}

/**
 * An ISIN names one security, so it finds a fund's issuer mark where a short ticker can belong to another
 * company. The ticker follows, then the company's own site icon.
 */
export function logoCandidates(ticker: string, isin?: string | null, domain?: string | null) {
  return [
    ...(isin ? [`https://assets.parqet.com/logos/isin/${isin}`] : []),
    `https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}`,
    ...(domain ? [`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`] : []),
  ];
}
