"use client";

import "./readings.css";
import { WorkspaceDrawer } from "../overlay";
import { ChevronDown, X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { useLocale } from "@/components/locale-provider";
import { MEDIA_QUERIES } from "@/lib/breakpoints";
import { useBreakpoint } from "@/lib/hooks";
import { useCopy } from "../foundation";
import type Link from "../link";
import { useAssistant, type RoleCard } from "./context";
import { readerText, type Evidence, type Reading } from "./evidence";
import { Citation } from "./citation";
import { beginCitationNavigation } from "./highlight";

/** A bottom sheet that opts in closes when one of its citations is followed, so the page can take focus. */
const FollowCitation = createContext<(() => void) | null>(null);

export type LiveBoardRecord = {
  observed: string;
  figures: readonly (string | number | boolean | null)[];
  heading: RefObject<HTMLElement | null>;
};

export function EvidenceLink({ evidence, observation, onNavigate, container, liveRecord }: {
  evidence: Evidence;
  observation?: string;
  container?: HTMLElement;
  liveRecord?: LiveBoardRecord;
  onNavigate?: ComponentProps<typeof Link>["onNavigate"];
}) {
  const { closeForCitation, open } = useAssistant();
  const leaveSheet = useContext(FollowCitation);
  const follow = () => {
    leaveSheet?.();
    if (open && window.matchMedia(MEDIA_QUERIES.compactDesktop).matches) closeForCitation();
  };
  return <Citation evidence={evidence} observation={observation} container={container}
    onOpenLocalRecord={liveRecord && (() => {
      if (!["market_sector", "global_map"].includes(evidence.tool) ||
        !canOpenLiveBoardRecord(evidence, liveRecord)) return false;
      beginCitationNavigation(window.location.href, () => liveRecord.heading.current);
      follow();
      return true;
    })}
    onNavigate={(event, href) => {
      let cancelled = false;
      onNavigate?.({preventDefault() { cancelled = true; event.preventDefault(); }});
      if (cancelled) return;
      beginCitationNavigation(href);
      follow();
    }} />;
}
function canOpenLiveBoardRecord(evidence: Evidence, liveRecord: LiveBoardRecord) {
  const args = evidence.arguments;
  if (!liveRecord.heading.current || !args?.boardRecord || args.observed !== liveRecord.observed) return false;
  try {
    // Parse the API's JSON so numeric formatting differences do not affect exact value comparison.
    return JSON.stringify(JSON.parse(args.boardRecord)) === JSON.stringify(liveRecord.figures);
  } catch {
    return false;
  }
}
export function ObservationLine({line, liveRecord}: {line: Reading["lines"][number]; liveRecord?: LiveBoardRecord}) {
  const {locale, timeZone} = useLocale();
  return <p className="mx-reading-line">{[line, ...(line.related ?? [])].map((item, i) =>
    <span key={i} className="mx-reading-observation">{readerText(item, locale, timeZone)} <EvidenceLink evidence={item.evidence} observation={item[locale]} liveRecord={liveRecord} /></span>
  )}</p>;
}
export function ReadingLines({card, lines = card.reading?.lines, liveRecord}: {card: RoleCard; lines?: Reading["lines"]; liveRecord?: LiveBoardRecord}) {
  return lines?.map((line, i) => <ObservationLine key={i} line={line} liveRecord={liveRecord} />);
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
  onFollowCitation?: () => void;
  showInline?: boolean;
};
function ReadingContent({ card, children }: ReadingContainerProps) {
  return <section className="mx-inline-reading"><CardTitle card={card} />{children ?? <ReadingLines card={card} />}<FollowUps card={card} /></section>;
}
function ReadingSheet({ card, children, onClose, focusClose, returnFocusRef, closeOnCitation, onFollowCitation }: ReadingContainerProps & {onClose: () => void}) {
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
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]:not([hidden]):not([data-closed]), [role="alertdialog"][aria-modal="true"]:not([hidden]):not([data-closed])');
      if (element.isConnected && (!dialog || dialog.contains(element))) element.focus({preventScroll:true});
    });
  }
  // The full-screen sidebar owns the phone screen; the sheet returns when it closes.
  if (open) return null;
  return <WorkspaceDrawer open onClose={dismiss} title={<span className="mx-reading-title"><span aria-hidden="true">✦</span>{card.title + " · " + card.object}</span>}
    finalFocus={false} closeRef={closeButton} closeLabel={t("关闭解读", "Close reading")}
    className="mx-reading-sheet">
    <FollowCitation.Provider value={onFollowCitation ?? (closeOnCitation ? onClose : null)}>
      {children ?? <ReadingLines card={card} />}<FollowUps card={card} onContinue={onClose} />
    </FollowCitation.Provider>
  </WorkspaceDrawer>;
}
export function InlineReading({ card, children, onClose, focusClose, returnFocusRef, closeOnCitation, onFollowCitation, showInline }: ReadingContainerProps) {
  const { ready } = useAssistant();
  const phone = useBreakpoint("phone");
  if (!ready) return null;
  return phone && onClose && !showInline
    ? <ReadingSheet card={card} onClose={onClose} focusClose={focusClose} returnFocusRef={returnFocusRef} closeOnCitation={closeOnCitation} onFollowCitation={onFollowCitation}>{children}</ReadingSheet>
    : <ReadingContent card={card}>{children}</ReadingContent>;
}
/** Mount beside a selected point in its positioned inspection surface. */
export function AnchoredReading({ card, onClose, children, closeOnCitation, onFollowCitation }: ReadingContainerProps & {onClose: () => void}) {
  const t = useCopy();
  const { ready } = useAssistant();
  const phone = useBreakpoint("phone");
  if (!ready) return null;
  if (phone) return <ReadingSheet card={card} onClose={onClose} closeOnCitation={closeOnCitation} onFollowCitation={onFollowCitation}>{children}</ReadingSheet>;
  return <div className="mx-anchored-reading"><button className="mx-reading-close" onClick={onClose} aria-label={t("关闭", "Close")}><X size={18} aria-hidden="true" /></button>
    <ReadingContent card={card}>{children}</ReadingContent></div>;
}
export function DigestRow({ storageKey, header, headline, summary, summarySource, children, pending }: { storageKey: string; header: ReactNode; headline: ReactNode; summary?: string; summarySource?: ReactNode; children: ReactNode; pending?: boolean }) {
  const { ready } = useAssistant();
  const id = useId();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("tm-reading-" + storageKey) === "open"; } catch { return false; } });
  if (!ready) return null;
  function toggle() {
    setOpen(!open);
    try { localStorage.setItem("tm-reading-" + storageKey, open ? "closed" : "open"); } catch {}
  }
  return <section className="mx-digest" data-waiting={pending || undefined}><div className="mx-digest-head"><span aria-hidden="true">✦</span>{header}
    <button className="mx-digest-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}><span className="mx-digest-label">{headline}{!open && summary && <span className="mx-digest-summary">{summary}</span>}</span><ChevronDown aria-hidden="true" size={16} /></button>{!open && summarySource}</div>
    <div id={id} hidden={!open}>{children}</div></section>;
}
