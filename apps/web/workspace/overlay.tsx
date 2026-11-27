"use client";

import { createContext, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { CloseButton } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import { isImeComposing } from "./shortcut-platform";

type PopupProps = React.ComponentProps<typeof DialogContent>;
type DismissEvent = { event: Event; cancel: () => void };

type OverlayProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number | string;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  closeClassName?: string;
  headerActions?: ReactNode;
  closeLabel?: string;
  closeRef?: React.Ref<HTMLButtonElement>;
  hideClose?: boolean;
  preventDismiss?: boolean;
  preventOutsideDismiss?: boolean;
  onClosed?: () => void;
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
  fullscreen?: boolean;
  modal?: boolean;
};

const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-slot="toast"]):not([hidden]):not([data-closed]), [role="alertdialog"]:not([data-slot="toast"]):not([hidden]):not([data-closed]), [aria-modal="true"]:not([hidden]):not([data-closed])';

/** True while any modal or dialog-role overlay is open and visible. */
export function hasOpenDialog() {
  return Boolean(document.querySelector(OPEN_DIALOG_SELECTOR));
}

export const OverlayPopupContainer = createContext<RefObject<HTMLDivElement | null> | undefined>(undefined);

export function WorkspaceDialog(props: OverlayProps) {
  return <Overlay {...props} kind="dialog" />;
}

export function WorkspaceAlertDialog(props: OverlayProps) {
  return <Overlay {...props} kind="alert" />;
}

export function WorkspaceSheet(props: OverlayProps) {
  return <Overlay {...props} kind="sheet" />;
}

export function WorkspaceDrawer(props: OverlayProps) {
  return <Overlay {...props} kind="drawer" />;
}

function Overlay({
  kind, open, onClose, title, children, width, className, headerClassName, bodyClassName,
  closeClassName, headerActions, closeLabel, closeRef, hideClose, preventDismiss, preventOutsideDismiss,
  onClosed, initialFocus, finalFocus, fullscreen, modal = true,
}: OverlayProps & { kind: "dialog" | "alert" | "sheet" | "drawer" }) {
  const { locale } = useLocale();
  const popup = useRef<HTMLDivElement>(null);
  const change = (nextOpen: boolean, details: DismissEvent) => {
    if (nextOpen) return;
    const event = details.event;
    if (preventDismiss || (event instanceof KeyboardEvent && (event.defaultPrevented || isImeComposing(event)))) {
      details.cancel();
      return;
    }
    onClose();
  };
  const complete = (nextOpen: boolean) => { if (!nextOpen) onClosed?.(); };
  const state = { open, onOpenChange: change, onOpenChangeComplete: complete };
  const focus: PopupProps["initialFocus"] = initialFocus ?? ((interaction) => {
    const target = popup.current?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)");
    if (target) return target;
    if (interaction === "touch") return popup.current?.querySelector<HTMLElement>("[data-overlay-close]") ?? true;
    return true;
  });
  const dismissOutside = preventDismiss || preventOutsideDismiss;
  const surface = {
    ref: popup, className, initialFocus: focus, finalFocus, "aria-modal": modal || undefined,
    style: width === undefined ? undefined : { "--tm-overlay-width": typeof width === "number" ? `${width}px` : width } as CSSProperties,
  };
  const Title = { dialog: DialogTitle, alert: AlertDialogTitle, sheet: SheetTitle, drawer: DrawerTitle }[kind];
  const Close = { dialog: DialogClose, alert: AlertDialogClose, sheet: SheetClose, drawer: DrawerClose }[kind];
  const heading = <>
    <div data-slot="dialog-header" className={cn("tm-overlay-header", headerClassName)}>
      <Title className="tm-overlay-title">{title}</Title>
      {headerActions}
      {!hideClose && <Close
        disabled={preventDismiss}
        ref={closeRef}
        render={<CloseButton data-overlay-close="" className={closeClassName} aria-label={closeLabel ?? (locale === "zh" ? "关闭" : "Close")} />}
      />}
    </div>
    <div className={cn("tm-overlay-body", bodyClassName)}>
      <OverlayPopupContainer.Provider value={popup}>{children}</OverlayPopupContainer.Provider>
    </div>
  </>;
  switch (kind) {
    case "drawer":
      return <Drawer {...state} showSwipeHandle disablePointerDismissal={dismissOutside}>
        <DrawerContent {...surface}>{heading}</DrawerContent>
      </Drawer>;
    case "sheet":
      return <Sheet {...state} modal={modal} disablePointerDismissal={dismissOutside}>
        <SheetContent {...surface} showBackdrop={modal} showCloseButton={false}>{heading}</SheetContent>
      </Sheet>;
    case "alert":
      return <AlertDialog {...state}>
        <AlertDialogContent {...surface}>{heading}</AlertDialogContent>
      </AlertDialog>;
    case "dialog":
      return <Dialog {...state} disablePointerDismissal={dismissOutside}>
        <DialogContent {...surface} showCloseButton={false} data-fullscreen={fullscreen || undefined}>{heading}</DialogContent>
      </Dialog>;
  }
}
