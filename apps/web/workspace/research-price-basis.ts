/**
 * One price per security. A held security is priced like the holdings page,
 * from the broker snapshot, when its broker line is the research quote's
 * listing; the research quote is the fallback and names its time only when it
 * is not the obvious current price.
 */

type Quote = {
  price?: number | null;
  currency?: string | null;
  change?: number | null;
  changePct?: number | null;
  asOf?: string | null;
  timezone?: string | null;
  delayMinutes?: number | null;
  listing?: string | null;
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

/** Regular sessions in exchange-local minutes. Holidays and half days are not modelled. */
const SESSIONS: Record<string, readonly [number, number]> = {
  "America/New_York": [570, 960],
  "America/Toronto": [570, 960],
  "Europe/London": [480, 990],
  "Europe/Dublin": [480, 990],
  "Europe/Amsterdam": [540, 1050],
  "Europe/Berlin": [540, 1050],
  "Europe/Brussels": [540, 1050],
  "Europe/Madrid": [540, 1050],
  "Europe/Milan": [540, 1050],
  "Europe/Paris": [540, 1050],
  "Europe/Zurich": [540, 1050],
  "Asia/Hong_Kong": [570, 960],
  "Asia/Shanghai": [570, 900],
  "Asia/Seoul": [540, 930],
  "Asia/Taipei": [540, 810],
  "Asia/Tokyo": [540, 930],
};
/** A delayed quote is late once it is older than its delay plus this margin. */
const LATE_MINUTES = 15;
/** Broker values refresh about every 10 minutes during a session. */
const BROKER_LATE_MINUTES = 30;

function exchangeClock(instant: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday as string,
  };
}

function validInstant(value: string | null | undefined) {
  if (!value) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? null : instant;
}

function session(zone: string | null | undefined) {
  return zone && Object.hasOwn(SESSIONS, zone) ? { zone, hours: SESSIONS[zone] } : null;
}

/** The first trading day after an exchange-local date, skipping weekends. */
function nextTradingDay(date: string) {
  const day = new Date(date + "T00:00:00Z");
  do day.setUTCDate(day.getUTCDate() + 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/** The last trading day before an exchange-local date, skipping weekends. */
function previousTradingDay(date: string) {
  const day = new Date(date + "T00:00:00Z");
  do day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/** Whether the exchange is in its regular session at `now`. */
export function inSession(zone: string | null | undefined, now: Date) {
  const known = session(zone);
  if (!known) return false;
  const clock = exchangeClock(now, known.zone);
  return (
    !["Sat", "Sun"].includes(clock.weekday) &&
    clock.minutes >= known.hours[0] &&
    clock.minutes < known.hours[1]
  );
}

/** How to name the time of a research quote, and whether it is late. */
export function quoteTime(quote: Quote, now: Date): PriceTime | null {
  const asOf = validInstant(quote.asOf);
  if (!asOf || !quote.asOf) return null;
  const known = session(quote.timezone);
  const delayMinutes = quote.delayMinutes ?? null;
  const age = (now.valueOf() - asOf.valueOf()) / 60_000;
  const late = age > (delayMinutes ?? 0) + LATE_MINUTES;
  if (!known) return { kind: "time", asOf: quote.asOf, stale: false, delayMinutes };
  const clock = exchangeClock(asOf, known.zone);
  if (clock.minutes >= known.hours[1]) {
    // A close is current until the next session has traded for longer than the delay.
    const next = nextTradingDay(clock.date);
    const today = exchangeClock(now, known.zone);
    const stale =
      today.date > next ||
      (today.date === next &&
        today.minutes >= known.hours[0] + (delayMinutes ?? 0) + LATE_MINUTES);
    return { kind: "close", date: clock.date, stale };
  }
  return { kind: "time", asOf: quote.asOf, stale: late, delayMinutes };
}

/** The close before the broker's trading day, when the quote can tell it. */
export function previousClose(quote: Quote, brokerAsOf: string | null | undefined) {
  const quoted = validInstant(quote.asOf);
  const broker = validInstant(brokerAsOf);
  const known = session(quote.timezone);
  if (quote.price == null || !quoted || !broker || !known) return null;
  const quoteDay = exchangeClock(quoted, known.zone);
  const brokerDay = exchangeClock(broker, known.zone);
  if (quoteDay.date === brokerDay.date)
    return quote.change != null ? quote.price - quote.change : null;
  // Only the immediately preceding session's close is the reference for the
  // broker's day; an older close would turn several sessions into one change.
  return quoteDay.date === previousTradingDay(brokerDay.date) && quoteDay.minutes >= known.hours[1]
    ? quote.price
    : null;
}

/**
 * Whether a broker price misses the latest session. During a session it must be
 * recent; outside one it must cover the latest completed session's close (the
 * last in-session refresh may land shortly before the close).
 */
export function brokerPriceLate(zone: string | null | undefined, asOf: Date, now: Date) {
  const known = session(zone);
  if (!known) return false;
  if (inSession(known.zone, now))
    return (now.valueOf() - asOf.valueOf()) / 60_000 > BROKER_LATE_MINUTES;
  const clock = exchangeClock(now, known.zone);
  const closedToday = !["Sat", "Sun"].includes(clock.weekday) && clock.minutes >= known.hours[1];
  const closeDate = closedToday ? clock.date : previousTradingDay(clock.date);
  const seen = exchangeClock(asOf, known.zone);
  return (
    seen.date < closeDate ||
    (seen.date === closeDate && seen.minutes < known.hours[1] - BROKER_LATE_MINUTES)
  );
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
              stale: brokerPriceLate(research.timezone, asOf, now),
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
