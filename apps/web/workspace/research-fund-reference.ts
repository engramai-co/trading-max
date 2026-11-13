import type { components } from "@/lib/api-schema";
import type { Copy } from "./etf-data";

export function usFundRelation(peer: components["schemas"]["USFundPeer"], t: Copy) {
  return peer.relation === "same-index" ? t("同一指数", "Same index") : t("相近", "Similar");
}
