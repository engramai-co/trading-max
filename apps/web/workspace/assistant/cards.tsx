"use client";

import "./readings.css";
import { Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { CaretDown, X } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { useLocale } from "@/components/locale-provider";
import { useCopy } from "../foundation";
import Link from "../link";
import { useAssistant, type RoleCard } from "./context";
import { evidenceHref, observationText, sourceLabel, type Evidence, type Reading } from "./evidence";

/** A bottom sheet that opts in closes when one of its citations is followed, so the page can take focus. */
const FollowCitation = createContext<(() => void) | null>(null);

export function EvidenceLink({ evidence, onNavigate }: { evidence: Evidence; onNavigate?: ComponentProps<typeof Link>["onNavigate"] }) {
  const t = useCopy();
  const { close, open } = useAssistant();
  const leaveSheet = useContext(FollowCitation);
  const word = sourceLabel(evidence, t);
  const href = evidenceHref(evidence);
  if (href && /^https?:/.test(href)) return <a className="mx-reading-source" href={href} title={evidence.arguments?.credit} rel="noreferrer" target="_blank">{word}</a>;
  return href ? <Link className="mx-reading-source" href={href} onNavigate={(event) => { onNavigate?.(event); leaveSheet?.(); }}
    onClick={() => { if (open && window.matchMedia("(max-width: 1199px)").matches) close(); }}>{word}</Link> : <span className="mx-reading-source">{word}</span>;
}
export function ObservationLine({line}: {line: Reading["lines"][number]}) {
  const {locale, timeZone} = useLocale();
  return <p className="mx-reading-line">{[line, ...(line.related ?? [])].map((item, i) =>
    <span key={i} className="mx-reading-observation">{observationText(item, locale, timeZone)} <EvidenceLink evidence={item.evidence} /></span>
  )}</p>;
}
export function ReadingLines({card, lines = card.reading?.lines}: {card: RoleCard; lines?: Reading["lines"]}) {
  return lines?.map((line, i) => <ObservationLine key={i} line={line} />);
}
export function CardTitle({ card }: { card: RoleCard }) {
  return <h3 className="mx-reading-title"><span aria-hidden="true">✦</span>{card.title}{card.object && " · " + card.object}</h3>;
}
export function FollowUps({ card, onContinue }: { card: RoleCard; onContinue?: () => void }) {
  const t = useCopy();
  const { continueInSidebar } = useAssistant();
  function handoff(draft?: string) {
    onContinue?.();
    continueInSidebar(card, draft);
  }
  return <div className="mx-reading-actions">{card.questions.map(q => <button key={q} disabled={card.pendingBinding} onClick={() => handoff(q)}>{q}</button>)}
    <button disabled={card.pendingBinding} className="mx-reading-continue" onClick={() => handoff()}>{t("在右栏继续 →", "Continue in sidebar →")}</button>
  </div>;
}
type ReadingContainerProps = {
  card: RoleCard; children?: ReactNode; onClose?: () => void; focusClose?: boolean; returnFocusRef?: RefObject<HTMLElement | null>;
  /** On phones, close the sheet when a citation inside it is followed. */
  closeOnCitation?: boolean;
};
function ReadingContent({ card, children }: ReadingContainerProps) {
  return <section className="mx-inline-reading"><CardTitle card={card} />{children ?? <ReadingLines card={card} />}<FollowUps card={card} /></section>;
}
function ReadingSheet({ card, children, onClose, focusClose, returnFocusRef, closeOnCitation }: ReadingContainerProps & {onClose: () => void}) {
  const t = useCopy();
  const { open } = useAssistant();
  const trigger = useRef(document.activeElement);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusClose) closeButton.current?.focus({preventScroll:true});
  }, [focusClose]);
  function dismiss() {
    const element = returnFocusRef?.current ?? trigger.current;
    onClose();
    if (element instanceof HTMLElement) requestAnimationFrame(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (element.isConnected && (!dialog || dialog.contains(element))) element.focus({preventScroll:true});
    });
  }
  // The full-screen sidebar owns the phone screen; the sheet returns when it closes.
  if (open) return null;
  return <Drawer opened onClose={dismiss} position="bottom" size="auto" title={<span className="mx-reading-title"><span aria-hidden="true">✦</span>{card.title + " · " + card.object}</span>}
    returnFocus={false} attributes={{header:{role:"presentation"}}} closeButtonProps={{ref:closeButton,"aria-label":t("关闭解读", "Close reading")}}
    classNames={{content:"mx-reading-sheet", inner:"mx-reading-sheet-inner"}}>
    <FollowCitation.Provider value={closeOnCitation ? onClose : null}>
      {children ?? <ReadingLines card={card} />}<FollowUps card={card} onContinue={onClose} />
    </FollowCitation.Provider>
  </Drawer>;
}
export function InlineReading({ card, children, onClose, focusClose, returnFocusRef, closeOnCitation }: ReadingContainerProps) {
  const { ready } = useAssistant();
  const phone = useMediaQuery("(max-width: 767px)");
  if (!ready) return null;
  return phone && onClose
    ? <ReadingSheet card={card} onClose={onClose} focusClose={focusClose} returnFocusRef={returnFocusRef} closeOnCitation={closeOnCitation}>{children}</ReadingSheet>
    : <ReadingContent card={card}>{children}</ReadingContent>;
}
/** Mount beside a selected point in its positioned inspection surface. */
export function AnchoredReading({ card, onClose, children, closeOnCitation }: ReadingContainerProps & {onClose: () => void}) {
  const t = useCopy();
  const { ready } = useAssistant();
  const phone = useMediaQuery("(max-width: 767px)");
  if (!ready) return null;
  if (phone) return <ReadingSheet card={card} onClose={onClose} closeOnCitation={closeOnCitation}>{children}</ReadingSheet>;
  return <div className="mx-anchored-reading"><button className="mx-reading-close" onClick={onClose} aria-label={t("关闭", "Close")}><X /></button>
    <ReadingContent card={card}>{children}</ReadingContent></div>;
}
export function DigestRow({ storageKey, header, headline, summary, summarySource, children }: { storageKey: string; header: ReactNode; headline: ReactNode; summary?: string; summarySource?: ReactNode; children: ReactNode }) {
  const { ready } = useAssistant();
  const id = useId();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("tm-reading-" + storageKey) === "open"; } catch { return false; } });
  if (!ready) return null;
  function toggle() {
    setOpen(!open);
    try { localStorage.setItem("tm-reading-" + storageKey, open ? "closed" : "open"); } catch {}
  }
  return <section className="mx-digest"><div className="mx-digest-head"><span aria-hidden="true">✦</span>{header}
    <button aria-expanded={open} aria-controls={id} onClick={toggle}><span className="mx-digest-label">{headline}{!open && summary && <span className="mx-digest-summary">{summary}</span>}</span><CaretDown size={16} /></button>{!open && summarySource}</div>
    <div id={id} hidden={!open}>{children}</div></section>;
}
