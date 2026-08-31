"use client";

import { Avatar } from "@mantine/core";
import { useMemo, useState } from "react";

function companyDomain(website: string): string | null {
  const value = website.trim();
  if (!value) return null;
  try {
    return new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    ).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

export function companyLogoSources(
  ticker: string,
  website = "",
): string[] {
  const canonicalTicker = ticker.trim().toUpperCase();
  const domain = companyDomain(website);
  const query = domain ? `?domain=${encodeURIComponent(domain)}` : "";
  return [`/api/company-logo/${encodeURIComponent(canonicalTicker)}${query}`];
}

export function CompanyMark({
  ticker,
  size = 34,
  website = "",
}: {
  name: string;
  ticker: string;
  size?: number;
  website?: string;
}) {
  const identity = `${ticker.trim().toUpperCase()}|${website.trim()}`;
  const sources = useMemo(
    () => companyLogoSources(ticker, website),
    [ticker, website],
  );
  const [failure, setFailure] = useState({ identity, index: 0 });
  const sourceIndex = failure.identity === identity ? failure.index : 0;

  return (
    <Avatar
      alt=""
      className="tm-company-mark"
      color="brand"
      imageProps={{
        onError: () =>
          setFailure({
            identity,
            index: sourceIndex + 1,
          }),
        referrerPolicy: "no-referrer",
      }}
      name={ticker}
      radius="md"
      size={size}
      src={sources[sourceIndex]}
    />
  );
}
