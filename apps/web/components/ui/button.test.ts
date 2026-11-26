import { act, createElement as el } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, CloseButton, buttonVariants } from "./button";
import { CopyButton, copyTextToClipboard } from "./copy-button";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buttonVariants", () => {
  it("uses Luma pill geometry and a single outline focus ring without box-shadow rings", () => {
    const classes = buttonVariants();
    expect(classes).toContain("rounded-full");
    expect(classes).toContain("focus-visible:outline-solid");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-offset-2");
    expect(classes).toContain("focus-visible:outline-ring");
    expect(classes).toContain("forced-colors:focus-visible:outline-[Highlight]");
    expect(classes).not.toMatch(/\bfocus-visible:ring-/);
  });

  it("enforces 40px desktop, 44px coarse touch, and 32px table-only sizes", () => {
    expect(buttonVariants({ size: "default" })).toContain("min-h-10");
    expect(buttonVariants({ size: "default" })).toContain("pointer-coarse:min-h-11");
    expect(buttonVariants({ size: "icon" })).toContain("size-10");
    expect(buttonVariants({ size: "icon" })).toContain("pointer-coarse:size-11");
    expect(buttonVariants({ size: "table" })).toContain("min-h-8");
    expect(buttonVariants({ size: "table" })).toContain("pointer-coarse:min-h-11");
  });

  it("gates the active press shrink behind motion-safe so reduced-motion presses do not scale", () => {
    const classes = buttonVariants();
    expect(classes).toContain("motion-safe:[&:not(:disabled):not([aria-disabled='true'])]:active:scale-[0.98]");
    expect(classes).not.toMatch(/(?<!motion-safe:)\[&:not\(:disabled\):not\(\[aria-disabled='true'\]\)\]:active:scale-/);
  });

  it("styles destructive confirmations with red text and outline only, never a red fill", () => {
    const classes = buttonVariants({ variant: "destructive" });
    expect(classes).toContain("border-destructive");
    expect(classes).toContain("bg-transparent");
    expect(classes).toContain("text-destructive");
    expect(classes).not.toContain("bg-destructive");
  });

  it("provides primary cobalt, secondary, outline, ghost, and link variants", () => {
    expect(buttonVariants({ variant: "default" })).toContain("bg-primary");
    expect(buttonVariants({ variant: "secondary" })).toContain("bg-secondary");
    expect(buttonVariants({ variant: "outline" })).toContain("border-border-strong");
    expect(buttonVariants({ variant: "ghost" })).toContain("bg-transparent");
    expect(buttonVariants({ variant: "link" })).toContain("text-link");
  });
});

describe("Button and CloseButton rendering", () => {
  it("reserves width for idle and loading labels and shows the loading label with a spinner when busy", () => {
    const plainHtml = renderToStaticMarkup(el(Button, null, "Save connection"));
    expect(plainHtml).not.toContain("inline-grid");
    expect(plainHtml).not.toContain("button-spinner");

    const idleHtml = renderToStaticMarkup(el(Button, { loadingLabel: "Saving…" }, "Save connection"));
    expect(idleHtml).toContain("inline-grid");
    expect(idleHtml).toContain("Save connection");
    expect(idleHtml).toContain("Saving…");
    expect(idleHtml).toContain('data-slot="button-spinner-placeholder"');
    expect(idleHtml).not.toContain('data-slot="button-spinner"');

    const busyHtml = renderToStaticMarkup(el(Button, { loading: true, loadingLabel: "Saving…" }, "Save connection"));
    expect(busyHtml).toContain('aria-busy="true"');
    expect(busyHtml).toContain('data-slot="button-spinner"');
    expect(busyHtml).toContain("Saving…");

    // Fallback without loadingLabel reserves the identical grid and spinner slot in both idle and loading states.
    const fallbackIdleHtml = renderToStaticMarkup(el(Button, { loading: false }, "Save connection"));
    const fallbackBusyHtml = renderToStaticMarkup(el(Button, { loading: true }, "Save connection"));
    expect(fallbackIdleHtml).toContain("inline-grid");
    expect(fallbackIdleHtml).toContain('data-slot="button-spinner-placeholder"');
    expect(fallbackIdleHtml).toContain("size-4 shrink-0");
    expect(fallbackIdleHtml).toContain("gap-2");
    expect(fallbackIdleHtml).not.toContain('data-slot="button-spinner"');
    expect(fallbackIdleHtml).not.toContain('aria-busy="true"');

    expect(fallbackBusyHtml).toContain("inline-grid");
    expect(fallbackBusyHtml).toContain('data-slot="button-spinner"');
    expect(fallbackBusyHtml).toContain("size-4 animate-spin");
    expect(fallbackBusyHtml).toContain("gap-2");
    expect(fallbackBusyHtml).toContain('aria-busy="true"');
    expect(fallbackBusyHtml).toContain("Save connection");

    const gridStructure = (html: string) => {
      const inner = html.slice(html.indexOf('<span class="inline-grid'));
      return inner
        .replace(/<svg[^>]*data-slot="button-spinner"[^>]*>[\s\S]*?<\/svg>/, "<SLOT/>")
        .replace(/<span data-slot="button-spinner-placeholder"[^>]*><\/span>/, "<SLOT/>")
        .replace(/ invisible opacity-0 pointer-events-none select-none/g, "")
        .replace(/ aria-hidden="true"/g, "");
    };
    expect(gridStructure(fallbackIdleHtml)).toBe(gridStructure(fallbackBusyHtml));
  });

  it("renders CloseButton as a standard 40px/44px icon button with a compact 16px default glyph", () => {
    const compact = renderToStaticMarkup(el(CloseButton, { "aria-label": "Close" }));
    expect(compact).toContain('data-size="icon"');
    expect(compact).toContain("size-10");
    expect(compact).toContain("pointer-coarse:size-11");
    expect(compact).not.toContain("size-8");
    expect(compact).toContain('width="16"');
    expect(compact).toContain('height="16"');

    const modalClose = renderToStaticMarkup(el(CloseButton, { "aria-label": "Close", iconSize: 18 }));
    expect(modalClose).toContain('data-size="icon"');
    expect(modalClose).toContain('width="18"');
    expect(modalClose).toContain('height="18"');
  });
});

describe("CopyButton unmount safety", () => {
  it("does not schedule a reset timer when unmounted before clipboard writeText resolves", async () => {
    type Listener = (event: unknown) => void;
    type FakeNode = {
      nodeType: number;
      nodeName: string;
      tagName: string;
      namespaceURI: string;
      ownerDocument: FakeDoc | null;
      childNodes: FakeNode[];
      parentNode: FakeNode | null;
      style: Record<string, string>;
      textContent: string | null;
      nodeValue?: string;
      data?: string;
      attributes: Map<string, string>;
      listeners: Map<string, Set<Listener>>;
      getAttribute: (name: string) => string | null;
      setAttribute: (name: string, value: string) => void;
      setAttributeNS: (_ns: string | null, name: string, value: string) => void;
      removeAttribute: (name: string) => void;
      addEventListener: (type: string, fn: Listener) => void;
      removeEventListener: (type: string, fn: Listener) => void;
      dispatchEvent: (event: { type: string; target?: unknown; currentTarget?: unknown; defaultPrevented?: boolean; preventDefault?: () => void; stopPropagation?: () => void }) => boolean;
      appendChild: <T extends FakeNode>(child: T) => T;
      removeChild: <T extends FakeNode>(child: T) => T;
      insertBefore: <T extends FakeNode>(child: T, ref: FakeNode | null) => T;
      querySelector: (selector: string) => FakeNode | null;
    };
    type FakeDoc = {
      nodeType: number;
      defaultView: unknown;
      documentElement: FakeNode;
      head: FakeNode;
      body: FakeNode;
      createElement: (tag: string) => FakeNode;
      createElementNS: (ns: string, tag: string) => FakeNode;
      createTextNode: (text: string) => FakeNode;
      createComment: (text: string) => FakeNode;
      getElementById: () => null;
      addEventListener: () => void;
      removeEventListener: () => void;
    };

    class FakeNodeBase {}
    class FakeElement extends FakeNodeBase {}
    class FakeHTMLElement extends FakeElement {}
    class FakeHTMLButtonElement extends FakeHTMLElement {}
    class FakeHTMLIFrameElement extends FakeHTMLElement {}

    const makeNode = (nodeType: number, nodeName: string, ownerDocument: FakeDoc | null, ns = "http://www.w3.org/1999/xhtml"): FakeNode => {
      const attrs = new Map<string, string>();
      const listeners = new Map<string, Set<Listener>>();
      const base =
        nodeType === 1 && nodeName === "BUTTON"
          ? new FakeHTMLButtonElement()
          : nodeType === 1
            ? new FakeHTMLElement()
            : new FakeNodeBase();
      const node: FakeNode = Object.assign(base, {
        nodeType,
        nodeName,
        tagName: nodeName,
        namespaceURI: ns,
        ownerDocument,
        childNodes: [] as FakeNode[],
        parentNode: null as FakeNode | null,
        style: {} as Record<string, string>,
        textContent: null as string | null,
        attributes: attrs,
        listeners,
        getAttribute: (name: string) => attrs.get(name) ?? null,
        setAttribute: (name: string, value: string) => { attrs.set(name, String(value)); },
        setAttributeNS: (_ns: string | null, name: string, value: string) => { attrs.set(name, String(value)); },
        removeAttribute: (name: string) => { attrs.delete(name); },
        addEventListener: (type: string, fn: Listener) => {
          let set = listeners.get(type);
          if (!set) { set = new Set(); listeners.set(type, set); }
          set.add(fn);
        },
        removeEventListener: (type: string, fn: Listener) => { listeners.get(type)?.delete(fn); },
        dispatchEvent: (event: { type: string; target?: unknown; currentTarget?: unknown; defaultPrevented?: boolean; preventDefault?: () => void; stopPropagation?: () => void }) => {
          event.target ??= node;
          event.preventDefault ??= () => { event.defaultPrevented = true; };
          event.stopPropagation ??= () => {};
          let cur: FakeNode | null = node;
          while (cur) {
            event.currentTarget = cur;
            for (const fn of [...(cur.listeners.get(event.type) ?? [])]) fn(event);
            cur = cur.parentNode;
          }
          return !event.defaultPrevented;
        },
        appendChild<T extends FakeNode>(child: T): T {
          child.parentNode = node;
          node.childNodes.push(child);
          return child;
        },
        removeChild<T extends FakeNode>(child: T): T {
          node.childNodes = node.childNodes.filter((item) => item !== child);
          child.parentNode = null;
          return child;
        },
        insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
          child.parentNode = node;
          const idx = ref ? node.childNodes.indexOf(ref) : -1;
          if (idx === -1) node.childNodes.push(child);
          else node.childNodes.splice(idx, 0, child);
          return child;
        },
        querySelector(selector: string): FakeNode | null {
          const targetTag = selector.toUpperCase();
          for (const child of node.childNodes) {
            if (child.tagName === targetTag) return child;
            const found = child.querySelector(selector);
            if (found) return found;
          }
          return null;
        },
      });
      return node;
    };

    const setTimeoutSpy = vi.fn(() => 42);
    const clearTimeoutSpy = vi.fn();
    const fakeDoc: FakeDoc = {
      nodeType: 9,
      defaultView: null,
      documentElement: null as unknown as FakeNode,
      head: null as unknown as FakeNode,
      body: null as unknown as FakeNode,
      createElement: (tag) => makeNode(1, tag.toUpperCase(), fakeDoc),
      createElementNS: (ns, tag) => makeNode(1, tag.toUpperCase(), fakeDoc, ns),
      createTextNode: (text) => Object.assign(makeNode(3, "#text", fakeDoc), { nodeValue: text, data: text }),
      createComment: (text) => Object.assign(makeNode(8, "#comment", fakeDoc), { nodeValue: text, data: text }),
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    fakeDoc.documentElement = makeNode(1, "HTML", fakeDoc);
    fakeDoc.head = makeNode(1, "HEAD", fakeDoc);
    fakeDoc.body = makeNode(1, "BODY", fakeDoc);
    fakeDoc.documentElement.appendChild(fakeDoc.head);
    fakeDoc.documentElement.appendChild(fakeDoc.body);

    const fakeWindow = {
      document: fakeDoc,
      Node: FakeNodeBase,
      Element: FakeElement,
      HTMLElement: FakeHTMLElement,
      HTMLButtonElement: FakeHTMLButtonElement,
      HTMLIFrameElement: FakeHTMLIFrameElement,
      setTimeout: setTimeoutSpy,
      clearTimeout: clearTimeoutSpy,
      addEventListener: () => {},
      removeEventListener: () => {},
      navigator: {},
    };
    fakeDoc.defaultView = fakeWindow;

    let resolveWrite!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("HTMLButtonElement", FakeHTMLButtonElement);
    vi.stubGlobal("Node", Object.assign(FakeNodeBase, { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8, DOCUMENT_NODE: 9 }));

    const container = fakeDoc.createElement("div");
    fakeDoc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        el(CopyButton, {
          value: "OAUTH-9999",
          label: "Copy code",
          copiedLabel: "Copied",
          failedLabel: "Copy failed",
        }),
      );
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    // Trigger copy while clipboard writeText stays pending, then unmount before resolution.
    await act(async () => {
      button!.dispatchEvent({ type: "click" });
    });
    expect(writeText).toHaveBeenCalledWith("OAUTH-9999");
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      resolveWrite();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

describe("copyTextToClipboard", () => {
  it("writes with navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await expect(copyTextToClipboard("TEST-1234")).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith("TEST-1234");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns false cleanly when clipboard rejects and no document exists", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await expect(copyTextToClipboard("TEST-1234")).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores previous focus when falling back to document.execCommand", async () => {
    const restoreFocus = vi.fn();
    class FakeHTMLElement {
      focus = restoreFocus;
    }
    const active = new FakeHTMLElement();
    const textarea = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      activeElement: active,
      createElement: vi.fn(() => textarea),
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => true),
    });
    try {
      await expect(copyTextToClipboard("FALLBACK-1")).resolves.toBe(true);
      expect(textarea.remove).toHaveBeenCalledTimes(1);
      expect(restoreFocus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
