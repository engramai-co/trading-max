"use client";

import { AlertCircle, Check, Copy } from "lucide-react";
import * as React from "react";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

/** Copy text using the Clipboard API with a synchronous execCommand fallback for non-secure or older contexts. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand when Clipboard API rejects (e.g. non-secure context).
    }
  }
  if (typeof document === "undefined") return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}

export interface CopyButtonProps
  extends Omit<ButtonProps, "children" | "onClick" | "loading" | "loadingLabel"> {
  value: string;
  /** Optional id of the element showing the text; enables native command="--copy" / commandfor when supported. */
  targetId?: string;
  label: string;
  iconOnly?: boolean;
  copiedLabel: string;
  failedLabel: string;
  announcedCopied?: string;
  announcedFailed?: string;
  timeout?: number;
}

export function CopyButton({
  value,
  targetId,
  label,
  iconOnly = false,
  copiedLabel,
  failedLabel,
  announcedCopied,
  announcedFailed,
  timeout = 2000,
  variant = "secondary",
  size = "default",
  className,
  ...props
}: CopyButtonProps) {
  const [state, setState] = React.useState<CopyState>("idle");
  const [announcement, setAnnouncement] = React.useState("");
  const timerRef = React.useRef<number | null>(null);
  const repeatRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const requestIdRef = React.useRef(0);

  const runCopy = React.useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const ok = await copyTextToClipboard(value);
    if (!mountedRef.current || requestId !== requestIdRef.current) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setState(ok ? "copied" : "failed");
    // Toggle a trailing non-breaking space so VoiceOver re-announces consecutive copies.
    repeatRef.current = !repeatRef.current;
    const baseMessage = ok ? (announcedCopied ?? copiedLabel) : (announcedFailed ?? failedLabel);
    setAnnouncement(baseMessage + (repeatRef.current ? "\u00A0" : ""));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setState("idle");
      setAnnouncement("");
    }, timeout);
  }, [value, announcedCopied, announcedFailed, copiedLabel, failedLabel, timeout]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Invoker Commands progressive enhancement (Safari 26.2+); older browsers including Safari 16.4 use onClick.
  const commandWiredRef = React.useRef(false);

  React.useEffect(() => {
    commandWiredRef.current = false;
    if (
      !targetId ||
      typeof window === "undefined" ||
      typeof HTMLButtonElement === "undefined" ||
      !("commandForElement" in HTMLButtonElement.prototype) ||
      !("CommandEvent" in window)
    ) {
      return;
    }
    const target = document.getElementById(targetId);
    if (!target) return;
    commandWiredRef.current = true;
    const onCommand = (event: Event) => {
      if ((event as Event & { command?: string }).command === "--copy") {
        void runCopy();
      }
    };
    target.addEventListener("command", onCommand);
    return () => {
      commandWiredRef.current = false;
      target.removeEventListener("command", onCommand);
    };
  }, [targetId, runCopy]);

  const invokerProps = targetId
    ? ({ command: "--copy", commandfor: targetId } as Record<string, string>)
    : undefined;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        data-copied={state === "copied" ? "" : undefined}
        data-failed={state === "failed" ? "" : undefined}
        className={className}
        onClick={() => {
          if (commandWiredRef.current) return;
          void runCopy();
        }}
        {...invokerProps}
        {...props}
      >
        <span className="inline-grid place-items-center">
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
              state !== "idle" && "invisible opacity-0 pointer-events-none select-none",
            )}
            aria-hidden={state !== "idle" ? true : undefined}
          >
            <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
            {iconOnly ? <span className="sr-only">{label}</span> : label}
          </span>
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
              state !== "copied" && "invisible opacity-0 pointer-events-none select-none",
            )}
            aria-hidden={state !== "copied" ? true : undefined}
          >
            <Check size={16} strokeWidth={1.75} aria-hidden="true" />
            {iconOnly ? <span className="sr-only">{copiedLabel}</span> : copiedLabel}
          </span>
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
              state !== "failed" && "invisible opacity-0 pointer-events-none select-none",
            )}
            aria-hidden={state !== "failed" ? true : undefined}
          >
            <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
            {iconOnly ? <span className="sr-only">{failedLabel}</span> : failedLabel}
          </span>
        </span>
      </Button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  );
}
