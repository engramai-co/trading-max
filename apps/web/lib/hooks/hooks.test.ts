import { act, createElement as el, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_QUERIES } from "@/lib/breakpoints";
import {
  detectOs,
  useBreakpoint,
  useDebouncedValue,
  useLocalStorage,
  useMediaQuery,
  useOs,
  useReducedMotion,
} from "./index";
import { resetLocalStorageStoreForTests } from "./use-local-storage";
import { resetOsCacheForTests } from "./use-os";

type FakeElement = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument | null;
  childNodes: FakeNode[];
  parentNode: FakeNode | null;
  style: Record<string, string>;
  textContent: string | null;
  setAttribute: () => void;
  removeAttribute: () => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  appendChild: <T extends FakeNode>(child: T) => T;
  removeChild: <T extends FakeNode>(child: T) => T;
  insertBefore: <T extends FakeNode>(child: T, ref: FakeNode | null) => T;
};

type FakeTextOrComment = FakeElement & { nodeValue: string; data: string };
type FakeNode = FakeElement | FakeTextOrComment;
type FakeDocument = {
  nodeType: number;
  defaultView: unknown;
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  createElement: (tag: string) => FakeElement;
  createTextNode: (text: string) => FakeTextOrComment;
  createComment: (text: string) => FakeTextOrComment;
  addEventListener: () => void;
  removeEventListener: () => void;
  querySelector: () => null;
  querySelectorAll: () => [];
};

function createDomEnvironment(initialStorage: Record<string, string> = {}) {
  const backing = new Map<string, string>(Object.entries(initialStorage));
  const windowListeners = new Map<string, Set<(event: unknown) => void>>();
  let throwOnSet = false;
  let throwOnGet = false;

  const makeNode = (nodeType: number, nodeName: string, ownerDocument: FakeDocument | null): FakeElement => {
    const node: FakeElement = {
      nodeType,
      nodeName,
      tagName: nodeName,
      ownerDocument,
      childNodes: [],
      parentNode: null,
      style: {},
      textContent: null,
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild(child) {
        child.parentNode = node;
        node.childNodes.push(child);
        return child;
      },
      removeChild(child) {
        node.childNodes = node.childNodes.filter((item) => item !== child);
        child.parentNode = null;
        return child;
      },
      insertBefore(child, ref) {
        child.parentNode = node;
        const idx = ref ? node.childNodes.indexOf(ref) : -1;
        if (idx === -1) node.childNodes.push(child);
        else node.childNodes.splice(idx, 0, child);
        return child;
      },
    };
    return node;
  };

  const localStorage = {
    getItem: (key: string) => {
      if (throwOnGet) throw new Error("storage read blocked");
      return backing.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (throwOnSet) throw new Error("QuotaExceededError");
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };

  const doc: FakeDocument = {
    nodeType: 9,
    defaultView: null,
    documentElement: makeNode(1, "HTML", null),
    head: makeNode(1, "HEAD", null),
    body: makeNode(1, "BODY", null),
    createElement: (tag) => makeNode(1, tag.toUpperCase(), doc),
    createTextNode: (text) => ({ ...makeNode(3, "#text", doc), nodeValue: text, data: text }),
    createComment: (text) => ({ ...makeNode(8, "#comment", doc), nodeValue: text, data: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  doc.documentElement.ownerDocument = doc;
  doc.head.ownerDocument = doc;
  doc.body.ownerDocument = doc;

  const fakeWindow = {
    document: doc,
    localStorage,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      let set = windowListeners.get(type);
      if (!set) {
        set = new Set();
        windowListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      windowListeners.get(type)?.delete(listener);
    },
  };
  doc.defaultView = fakeWindow;

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", fakeWindow);

  return {
    backing,
    doc,
    setThrowOnSet(next: boolean) {
      throwOnSet = next;
    },
    setThrowOnGet(next: boolean) {
      throwOnGet = next;
    },
    dispatchStorage(key: string | null, newValue: string | null) {
      if (key === null) {
        backing.clear();
      } else if (newValue === null) {
        backing.delete(key);
      } else {
        backing.set(key, newValue);
      }
      for (const listener of windowListeners.get("storage") ?? []) {
        listener({ storageArea: localStorage, key, newValue });
      }
    },
  };
}

afterEach(() => {
  resetLocalStorageStoreForTests();
  resetOsCacheForTests();
  vi.unstubAllGlobals();
});

describe("project hooks SSR snapshots and helpers", () => {
  it("returns Mantine-compatible SSR snapshots for media, motion, os, storage, and debounce hooks", () => {
    function Probe() {
      const phone = useBreakpoint("phone");
      const custom = useMediaQuery(MEDIA_QUERIES.wide, true);
      const reduced = useReducedMotion();
      const os = useOs();
      const [stored] = useLocalStorage({ key: "tm-test-key", defaultValue: "fallback" });
      const [debounced] = useDebouncedValue("initial", 250);
      return el(
        "div",
        null,
        JSON.stringify({ phone, custom, reduced, os, stored, debounced }),
      );
    }

    const html = renderToStaticMarkup(el(Probe));
    expect(html).toBe(
      `<div>${JSON.stringify({
        phone: false,
        custom: true,
        reduced: false,
        os: "undetermined",
        stored: "fallback",
        debounced: "initial",
      }).replace(/"/g, "&quot;")}</div>`,
    );
  });

  it("detects operating systems identically to @mantine/hooks useOs", () => {
    expect(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
    expect(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", true)).toBe("ios");
    expect(detectOs("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectOs("Mozilla/5.0 (Linux; Android 14)")).toBe("android");
    expect(detectOs("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)")).toBe("chromeos");
    expect(detectOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectOs("CustomBot/1.0")).toBe("undetermined");
  });

  it("keeps pending writes and supports functional updates when setItem throws on readable storage", () => {
    const env = createDomEnvironment({ "tm-full": JSON.stringify(["a"]) });
    env.setThrowOnSet(true);

    const DEFAULT_LIST: string[] = [];
    let latestValue: string[] = [];
    let latestSet: ((next: string[] | ((prev: string[]) => string[])) => void) | null = null;
    let latestRemove: (() => void) | null = null;
    let peerValue: string[] = [];

    function Primary() {
      const [value, setValue, removeValue] = useLocalStorage<string[]>({
        key: "tm-full",
        defaultValue: DEFAULT_LIST,
      });
      useEffect(() => {
        latestValue = value;
        latestSet = setValue;
        latestRemove = removeValue;
      });
      return el("span", null, JSON.stringify(value));
    }

    function Peer() {
      const [value] = useLocalStorage<string[]>({
        key: "tm-full",
        defaultValue: DEFAULT_LIST,
      });
      useEffect(() => {
        peerValue = value;
      });
      return el("span", null, JSON.stringify(value));
    }

    const container = env.doc.createElement("div");
    const root = createRoot(container as unknown as Element);

    act(() => {
      root.render(el("div", null, el(Primary), el(Peer)));
    });
    expect(latestValue).toEqual(["a"]);
    expect(peerValue).toEqual(["a"]);

    // Storage is readable (still holds ["a"]), but setItem throws.
    act(() => {
      latestSet!(["a", "b"]);
    });
    expect(latestValue).toEqual(["a", "b"]);
    expect(peerValue).toEqual(["a", "b"]);
    expect(env.backing.get("tm-full")).toBe(JSON.stringify(["a"]));

    // Subsequent functional update reads the pending in-memory value rather than stale storage.
    act(() => {
      latestSet!((prev) => [...prev, "c"]);
    });
    expect(latestValue).toEqual(["a", "b", "c"]);
    expect(peerValue).toEqual(["a", "b", "c"]);

    // Once setItem succeeds again, the write persists and clears the pending fallback.
    env.setThrowOnSet(false);
    act(() => {
      latestSet!((prev) => [...prev, "d"]);
    });
    expect(latestValue).toEqual(["a", "b", "c", "d"]);
    expect(env.backing.get("tm-full")).toBe(JSON.stringify(["a", "b", "c", "d"]));

    // A failing write followed by removeValue clears the pending value and falls back to defaultValue.
    env.setThrowOnSet(true);
    act(() => {
      latestSet!(["temp"]);
    });
    expect(latestValue).toEqual(["temp"]);
    act(() => {
      latestRemove!();
    });
    expect(latestValue).toEqual([]);
    expect(env.backing.has("tm-full")).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it("shares key state across instances, handles cross-tab storage events, and clears stale pending fallback", () => {
    const env = createDomEnvironment({ "tm-sync": JSON.stringify("initial") });
    env.setThrowOnSet(true);

    let latestValue = "";
    let peerValue = "";
    let latestSet: ((next: string | ((prev: string) => string)) => void) | null = null;

    function Probe() {
      const [value, setValue] = useLocalStorage({
        key: "tm-sync",
        defaultValue: "default",
      });
      useEffect(() => {
        latestValue = value;
        latestSet = setValue;
      });
      return el("span", null, value);
    }

    function Peer() {
      const [value] = useLocalStorage({
        key: "tm-sync",
        defaultValue: "default",
      });
      useEffect(() => {
        peerValue = value;
      });
      return el("span", null, value);
    }

    const container = env.doc.createElement("div");
    const root = createRoot(container as unknown as Element);

    act(() => {
      root.render(el("div", null, el(Probe), el(Peer)));
    });
    expect(latestValue).toBe("initial");
    expect(peerValue).toBe("initial");

    // Failed local write puts a pending value in memory and shares it across instances.
    act(() => {
      latestSet!("pending-local");
    });
    expect(latestValue).toBe("pending-local");
    expect(peerValue).toBe("pending-local");

    // Cross-tab update commits to storage and notifies all mounted instances.
    act(() => {
      env.dispatchStorage("tm-sync", JSON.stringify("from-other-tab"));
    });
    expect(latestValue).toBe("from-other-tab");
    expect(peerValue).toBe("from-other-tab");

    // Cross-tab clear (key === null) resets all instances to defaultValue.
    act(() => {
      env.dispatchStorage(null, null);
    });
    expect(latestValue).toBe("default");
    expect(peerValue).toBe("default");

    act(() => {
      root.unmount();
    });
  });
});
