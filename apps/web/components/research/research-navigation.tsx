"use client";

import { WatchlistNavigator } from "@/components/watchlist-navigator";
import type { ResearchInstrument, SecuritySearchResult, WatchlistCategory } from "@/lib/types";

export function ResearchNavigation({
  categories,
  instruments,
  mock,
  onSelectTicker,
  onTickerAdded,
  onTickerRemoved,
  openSignal,
  selectedTicker,
}: {
  categories: WatchlistCategory[];
  instruments: ResearchInstrument[];
  mock?: boolean;
  onSelectTicker: (ticker: string) => void;
  onTickerAdded: (security: SecuritySearchResult) => void;
  onTickerRemoved: (ticker: string) => void;
  openSignal: number;
  selectedTicker: string;
}) {
  return (
    <WatchlistNavigator
      categories={categories}
      headless
      instruments={instruments}
      mock={mock}
      onSelectTicker={onSelectTicker}
      onTickerAdded={onTickerAdded}
      onTickerRemoved={onTickerRemoved}
      openSignal={openSignal}
      selectedTicker={selectedTicker}
    />
  );
}
