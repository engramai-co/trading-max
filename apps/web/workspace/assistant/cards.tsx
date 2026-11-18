"use client";

import { Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { CaretDown, X } from "@phosphor-icons/react";
import { useId, useState, type ReactNode } from "react";
import { useCopy } from "../foundation";
import Link from "../link";
import { useAssistant, type RoleCard } from "./context";
import { evidenceHref, sourceWords, type Evidence } from "./evidence";

export function EvidenceLink({ evidence }: { evidence: Evidence }) {
  const t = useCopy();
  const word = t(...sourceWords[evidence.source] as [string, string]);
  const href = evidenceHref(evidence);
  return href ? <Link className="mx-reading-source" href={href}>{word}</Link> : <span className="mx-reading-source">{word}</span>;
}
export function ReadingLines({ card }: { card: RoleCard }) {
  const t = useCopy();
  return card.reading?.lines.map((line, i) => <p className="mx-reading-line" key={i}>
    {t(line.zh, line.en)}{" "}<EvidenceLink evidence={line.evidence} />
  </p>);
}
export function CardTitle({ card }: { card: RoleCard }) {
  return <h3 className="mx-reading-title"><span aria-hidden="true">✦</span>{card.title}{card.object && " · " + card.object}</h3>;
}
export function FollowUps({ card }: { card: RoleCard }) {
  const t = useCopy();
  const { continueInSidebar } = useAssistant();
  return <div className="mx-reading-actions">{card.questions.map(q => <button key={q} onClick={() => continueInSidebar(card, q)}>{q}</button>)}
    <button className="mx-reading-continue" onClick={() => continueInSidebar(card)}>{t("在右栏继续 →", "Continue in sidebar →")}</button>
  </div>;
}
export function InlineReading({ card, children }: { card: RoleCard; children?: ReactNode }) {
  const { ready } = useAssistant();
  if (!ready) return null;
  return <section className="mx-inline-reading"><CardTitle card={card} />{children ?? <ReadingLines card={card} />}<FollowUps card={card} /></section>;
}
/** Mount beside a selected point in its positioned inspection surface. */
export function AnchoredReading({ card, onClose, children }: { card: RoleCard; onClose: () => void; children?: ReactNode }) {
  const t = useCopy();
  const { ready } = useAssistant();
  const phone = useMediaQuery("(max-width: 767px)");
  if (!ready) return null;
  const content = <InlineReading card={card}>{children}</InlineReading>;
  if (phone) return <Drawer opened onClose={onClose} position="bottom" size="auto" title={card.title} classNames={{content:"mx-reading-sheet"}}>{content}</Drawer>;
  return <div className="mx-anchored-reading"><button className="mx-reading-close" onClick={onClose} aria-label={t("关闭", "Close")}><X /></button>{content}</div>;
}
export function DigestRow({ storageKey, header, headline, children }: { storageKey: string; header: ReactNode; headline: ReactNode; children: ReactNode }) {
  const { ready } = useAssistant();
  const id = useId();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("tm-reading-" + storageKey) === "open"; } catch { return false; } });
  if (!ready) return null;
  function toggle() {
    setOpen(!open);
    try { localStorage.setItem("tm-reading-" + storageKey, open ? "closed" : "open"); } catch {}
  }
  return <section className="mx-digest"><div className="mx-digest-head"><span aria-hidden="true">✦</span>{header}
    <button aria-expanded={open} aria-controls={id} onClick={toggle}>{headline}<CaretDown size={16} /></button></div>
    <div id={id} hidden={!open}>{children}</div></section>;
}
