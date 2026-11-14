/**
 * One price per security. A held security is priced like the holdings page,
 * from the broker snapshot, when its broker line is the research quote's
 * listing; the research quote is the fallback and names its time only when it
 * is not the obvious current price. Sessions come from the server, from the
 * quote exchange's own calendar: holidays and early closes included. Instants
 * the schedule does not reach belong to no session, and once it has run out
 * nothing is shown as current until the lens is refetched.
 */

type Session = { date: string; open: string; close: string };

type Quote = {
  price?: number | null;
  currency?: string | null;
  change?: number | null;
  changePct?: number | null;
  asOf?: string | null;
  delayMinutes?: number | null;
  listing?: string | null;
  schedule?: { sessions?: Session[] | null; until?: string | null } | null;
};

type Position = {
  held?: boolean;
  brokerPrice?: number | null;
  brokerPriceCurrency?: string | null;
  brokerAsOf?: string | null;
  brokerListing?: string | null;
};

/** The time beside a price: a session close, or an instant in the display time zone. */
export type PriceTime =
  | { kind: "close"; date: string; stale: boolean }
  | { kind: "time"; asOf: string; stale: boolean; delayMinutes: number | null };

export type PriceBasis = {
  source: "broker" | "quote";
  price: number | null;
  currency: string | null;
  change: number | null;
  changePct: number | null;
  time: PriceTime | null;
};

/** The price figures on the research page are quoted against, with its time. */
export type ResearchPrice = {
  source: "broker" | "quote";
  price: number | null;
  currency: string | null;
  asOf: string | null;
};

const MINUTE = 60_000;
/** A delayed quote is late once it is older than its delay plus this margin. */
const LATE_MINUTES = 15;
/** Broker values refresh about every 10 minutes during a session. */
const BROKER_LATE_MINUTES = 30;

type Scheduled = { date: string; open: number; close: number };
/** Sessions as instants; the list is complete until `until`. */
type Calendar = { sessions: Scheduled[]; until: number };

function validInstant(value: string | null | undefined) {
  if (!value) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? null : instant;
}

/** The quote exchange's sessions in time order; null when the exchange is unknown. */
function calendar(quote: Quote | undefined): Calendar | null {
  const sessions = (quote?.schedule?.sessions ?? [])
    .map((s) => ({ date: s.date, open: Date.parse(s.open), close: Date.parse(s.close) }))
    .filter((s) => s.open < s.close)
    .sort((a, b) => a.open - b.open);
  if (!sessions.length) return null;
  const last = sessions[sessions.length - 1].close;
  const until = Date.parse(quote?.schedule?.until ?? "");
  // Without its end a schedule reaches its last close.
  return { sessions, until: until > last ? until : last };
}

/** The session an instant belongs to (the latest one open by then), or -1 beyond the schedule. */
function sessionOf({ sessions, until }: Calendar, instant: Date) {
  const time = instant.valueOf();
  if (time < sessions[0].open || time >= until) return -1;
  return sessions.findLastIndex((s) => s.open <= time);
}

function quoteObservation(asOf: string, known: Calendar | null) {
  // A daily bar names the exchange's completed session, with no time zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    const index = known?.sessions.findIndex((s) => s.date === asOf) ?? -1;
    return { kind: "close", index, date: asOf } as const;
  }
  const instant = validInstant(asOf);
  if (!instant) return null;
  const index = known ? sessionOf(known, instant) : -1;
  const session = known?.sessions[index];
  return session && instant.valueOf() >= session.close
    ? { kind: "close", index, date: session.date } as const
    : { kind: "time", index, instant } as const;
}

/** Whether the quote's schedule has run out: a session it does not list may have opened. */
export function scheduleExpired(quote: Quote | undefined, now: Date) {
  const known = calendar(quote);
  return known != null && now.valueOf() >= known.until;
}

/** Whether the quote's exchange is in a session at `now`. */
export function inSession(quote: Quote | undefined, now: Date) {
  const known = calendar(quote);
  const time = now.valueOf();
  return Boolean(
    known && time < known.until && known.sessions.some((s) => s.open <= time && time < s.close),
  );
}

/** How to name the time of a research quote, and whether it is late. */
export function quoteTime(quote: Quote, now: Date): PriceTime | null {
  const { asOf } = quote;
  if (!asOf) return null;
  const known = calendar(quote);
  const observation = quoteObservation(asOf, known);
  if (!observation) return null;
  const delayMinutes = quote.delayMinutes ?? null;
  const lateAfter = ((delayMinutes ?? 0) + LATE_MINUTES) * MINUTE;
  // A schedule that has run out cannot show anything as current.
  const expired = known != null && now.valueOf() >= known.until;
  if (observation.kind === "close") {
    const { date, index } = observation;
    // A close is current until the next session has traded for longer than the delay.
    const next = known?.sessions[index + 1];
    const stale = known != null &&
      (expired || index < 0 || (next != null && now.valueOf() >= next.open + lateAfter));
    return { kind: "close", date, stale };
  }
  // An unknown exchange makes no claim about freshness.
  const stale = known != null && (expired || now.valueOf() - observation.instant.valueOf() > lateAfter);
  return { kind: "time", asOf, stale, delayMinutes };
}

/** The close before the broker price's session, when the quote can tell it. */
export function previousClose(quote: Quote, brokerAsOf: string | null | undefined) {
  const broker = validInstant(brokerAsOf);
  const known = calendar(quote);
  if (quote.price == null || !quote.asOf || !broker || !known) return null;
  const observation = quoteObservation(quote.asOf, known);
  if (!observation) return null;
  // A price observed outside a session belongs to the latest session before it;
  // one the schedule does not reach belongs to none it can compare.
  const brokerSession = sessionOf(known, broker);
  const quoteSession = observation.index;
  if (brokerSession < 0 || quoteSession < 0) return null;
  if (quoteSession === brokerSession)
    return quote.change != null ? quote.price - quote.change : null;
  // Only the immediately preceding session's close is the reference for the
  // broker's session; an older close would turn several sessions into one change.
  return quoteSession === brokerSession - 1 && observation.kind === "close" ? quote.price : null;
}

/**
 * Whether a broker price misses the latest session. During a session it must be
 * recent; outside one it must cover the latest completed session's close (the
 * last in-session refresh may land shortly before the close).
 */
export function brokerPriceLate(quote: Quote | undefined, asOf: Date, now: Date) {
  const known = calendar(quote);
  if (!known) return false;
  const time = now.valueOf();
  // A schedule that has run out cannot show a broker price as current.
  if (time >= known.until) return true;
  const margin = BROKER_LATE_MINUTES * MINUTE;
  if (known.sessions.some((s) => s.open <= time && time < s.close))
    return time - asOf.valueOf() > margin;
  const closed = known.sessions.findLast((s) => s.close <= time);
  return closed != null && asOf.valueOf() < closed.close - margin;
}

/**
 * The price figures on the research page are quoted against. A held security
 * uses the broker price only when its one broker line is the research quote's
 * listing, in the quote's currency. A line on another market, a `.L` alias or
 * several lines under one ticker keep the research basis, so analyst targets,
 * charts and statements stay on it.
 */
export function basisPrice(
  position: Position | undefined,
  quote: Quote | undefined,
  fallbackPrice: number | null = null,
  fallbackCurrency: string | null = null,
): ResearchPrice {
  const brokerPrice = position?.held ? position.brokerPrice : null;
  const sameListing =
    Boolean(quote?.listing) &&
    position?.brokerListing === quote?.listing &&
    Boolean(quote?.currency) &&
    position?.brokerPriceCurrency === quote?.currency;
  return brokerPrice != null && brokerPrice > 0 && sameListing
    ? {
        source: "broker",
        price: brokerPrice,
        currency: quote?.currency ?? null,
        asOf: position?.brokerAsOf ?? null,
      }
    : {
        source: "quote",
        price: quote?.price ?? fallbackPrice,
        currency: quote?.currency || fallbackCurrency,
        asOf: quote?.asOf ?? null,
      };
}

export function priceBasis(
  position: Position | undefined,
  quote: Quote | undefined,
  fallbackPrice: number | null,
  fallbackCurrency: string | null,
  now: Date,
): PriceBasis {
  const research = quote ?? {};
  const { source, price, currency } = basisPrice(position, quote, fallbackPrice, fallbackCurrency);
  if (source === "broker" && price != null) {
    const reference = previousClose(research, position?.brokerAsOf);
    const change = reference ? price - reference : null;
    const asOf = validInstant(position?.brokerAsOf);
    return {
      source: "broker",
      price,
      currency,
      change,
      changePct: change != null && reference ? change / reference : null,
      time:
        asOf && position?.brokerAsOf
          ? {
              kind: "time",
              asOf: position.brokerAsOf,
              stale: brokerPriceLate(research, asOf, now),
              delayMinutes: null,
            }
          : null,
    };
  }
  return {
    source: "quote",
    price,
    currency,
    change: research.change ?? null,
    changePct: research.changePct ?? null,
    time: quoteTime(research, now),
  };
}
