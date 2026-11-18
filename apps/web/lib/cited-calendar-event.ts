/** URL values from saved calendar citations, including the original ex-dividend spelling. */
export function citedEventKind(event: string | null | undefined) {
  switch (event) {
    case "earnings":
    case "earningsWindow":
      return "earnings";
    case "exDividend":
    case "ex_dividend":
      return "ex_dividend";
    case "dividend_pay":
    case "rating_change":
    case "filing":
    case "macro":
    case "dividend":
      return event;
    default:
      return null;
  }
}
