import { act, createElement as el, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLOR_SCHEME_ATTRIBUTE,
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_COLOR_SCHEME,
  THEME_COLOR_BY_SCHEME,
  colorSchemeHtmlProps,
  colorSchemeInitScript,
  isColorScheme,
} from "@/lib/color-scheme";
import {
  ColorSchemeProvider,
  createMantineColorSchemeManager,
  resetColorSchemeStoreForTests,
  resolveColorScheme,
  useColorScheme,
  useComputedColorScheme,
} from "./color-scheme-provider";
import { ColorSchemeScript } from "./color-scheme-script";

function createFakeBrowser({
  stored = null as string | null,
  prefersDark = false,
  pathname = "/",
  throwOnStorageAccess = false,
} = {}) {
  const storage = new Map<string, string>();
  if (stored !== null) storage.set(COLOR_SCHEME_STORAGE_KEY, stored);
  const attrs = new Map<string, string>();
  const metaContents = new Map<string, string>([
    ["color-scheme", "light dark"],
    ["theme-color", THEME_COLOR_BY_SCHEME.dark],
  ]);
  const mqlListeners = new Set<() => void>();
  const windowListeners = new Map<string, Set<(event: unknown) => void>>();
  let dark = prefersDark;
  let throwOnGetItem = false;

  const localStorage = {
    getItem: (key: string) => {
      if (throwOnGetItem) throw new Error("SecurityError: getItem blocked");
      return storage.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };

  const matchMedia = () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_type: string, listener: () => void) => {
      mqlListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      mqlListeners.delete(listener);
    },
  });

  type FakeDomNode = {
    nodeType: number;
    nodeName: string;
    tagName: string;
    ownerDocument: unknown;
    childNodes: FakeDomNode[];
    parentNode: FakeDomNode | null;
    style: Record<string, string>;
    textContent: string | null;
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
    removeAttribute: () => void;
    addEventListener: () => void;
    removeEventListener: () => void;
    appendChild: (child: FakeDomNode) => FakeDomNode;
    removeChild: (child: FakeDomNode) => FakeDomNode;
    insertBefore: (child: FakeDomNode, ref: FakeDomNode | null) => FakeDomNode;
  };

  const makeDomNode = (nodeType: number, nodeName: string): FakeDomNode => {
    const node: FakeDomNode = {
      nodeType,
      nodeName,
      tagName: nodeName,
      ownerDocument: null,
      childNodes: [],
      parentNode: null,
      style: {},
      textContent: null,
      getAttribute: (name: string) => (nodeName === "HTML" ? (attrs.get(name) ?? null) : null),
      setAttribute: (name: string, value: string) => {
        if (nodeName === "HTML") attrs.set(name, value);
      },
      removeAttribute: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: (child) => {
        child.parentNode = node;
        node.childNodes.push(child);
        return child;
      },
      removeChild: (child) => {
        node.childNodes = node.childNodes.filter((item) => item !== child);
        child.parentNode = null;
        return child;
      },
      insertBefore: (child, ref) => {
        child.parentNode = node;
        const idx = ref ? node.childNodes.indexOf(ref) : -1;
        if (idx === -1) node.childNodes.push(child);
        else node.childNodes.splice(idx, 0, child);
        return child;
      },
    };
    return node;
  };

  const makeMetaNode = (metaName: string) => ({
    getAttribute: (attr: string) => (attr === "content" ? (metaContents.get(metaName) ?? null) : null),
    setAttribute: (attr: string, value: string) => {
      if (attr === "content") metaContents.set(metaName, value);
    },
  });

  const metaNodes: Record<string, ReturnType<typeof makeMetaNode>> = {
    'meta[name="color-scheme"]': makeMetaNode("color-scheme"),
    'meta[name="theme-color"]': makeMetaNode("theme-color"),
  };

  const documentElement = makeDomNode(1, "HTML");
  const head = makeDomNode(1, "HEAD");
  const body = makeDomNode(1, "BODY");

  const fakeWindow: Record<string, unknown> = {
    location: { pathname },
    matchMedia,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
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

  if (throwOnStorageAccess) {
    Object.defineProperty(fakeWindow, "localStorage", {
      get() {
        throw new Error("SecurityError: storage blocked");
      },
      configurable: true,
    });
  } else {
    fakeWindow.localStorage = localStorage;
  }

  const fakeDocument = {
    nodeType: 9,
    defaultView: fakeWindow,
    documentElement,
    head,
    body,
    querySelector: (selector: string) => metaNodes[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag: string) => {
      const node = makeDomNode(1, tag.toUpperCase());
      node.ownerDocument = fakeDocument;
      return node;
    },
    createTextNode: (text: string) => ({
      ...makeDomNode(3, "#text"),
      ownerDocument: fakeDocument,
      nodeValue: text,
      data: text,
    }),
    createComment: (text: string) => ({
      ...makeDomNode(8, "#comment"),
      ownerDocument: fakeDocument,
      nodeValue: text,
      data: text,
    }),
  };
  documentElement.ownerDocument = fakeDocument;
  head.ownerDocument = fakeDocument;
  body.ownerDocument = fakeDocument;
  fakeWindow.document = fakeDocument;

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);

  return {
    storage,
    attrs,
    metaContents,
    fakeDocument,
    setPrefersDark(next: boolean) {
      dark = next;
      for (const listener of mqlListeners) listener();
    },
    setThrowOnGetItem(next: boolean) {
      throwOnGetItem = next;
    },
    dispatchStorage(newValue: string | null) {
      if (newValue === null) storage.delete(COLOR_SCHEME_STORAGE_KEY);
      else storage.set(COLOR_SCHEME_STORAGE_KEY, newValue);
      for (const listener of windowListeners.get("storage") ?? []) {
        listener({
          storageArea: localStorage,
          key: COLOR_SCHEME_STORAGE_KEY,
          newValue,
        });
      }
    },
    dispatchQueuedStorage(
      newValue: string | null,
      key: string | null = COLOR_SCHEME_STORAGE_KEY,
    ) {
      for (const listener of windowListeners.get("storage") ?? []) {
        listener({
          storageArea: localStorage,
          key,
          newValue,
        });
      }
    },
  };
}

afterEach(() => {
  resetColorSchemeStoreForTests();
  vi.unstubAllGlobals();
});

describe("color-scheme script and provider", () => {
  it("defaults to dark, validates colour scheme values, and emits matching html props", () => {
    expect(DEFAULT_COLOR_SCHEME).toBe("dark");
    expect(isColorScheme("light")).toBe(true);
    expect(isColorScheme("dark")).toBe(true);
    expect(isColorScheme("auto")).toBe(true);
    expect(isColorScheme("sepia")).toBe(false);
    expect(colorSchemeHtmlProps).toEqual({
      suppressHydrationWarning: true,
      [COLOR_SCHEME_ATTRIBUTE]: "dark",
    });
  });

  it("renders a blocking head script that defaults fresh visitors to dark and honours stored light, dark, and auto", () => {
    const html = renderToStaticMarkup(el(ColorSchemeScript, {}));
    expect(html).toContain("<script");
    expect(html).toContain(COLOR_SCHEME_STORAGE_KEY);
    expect(html).toContain(COLOR_SCHEME_ATTRIBUTE);

    const script = colorSchemeInitScript();

    // Fresh visitor (no stored value) gets dark even if OS prefers light.
    const freshLightOs = createFakeBrowser({ stored: null, prefersDark: false });
    new Function(script)();
    expect(freshLightOs.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(freshLightOs.metaContents.get("color-scheme")).toBe("dark");
    expect(freshLightOs.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.dark);

    const light = createFakeBrowser({ stored: "light", prefersDark: true });
    new Function(script)();
    expect(light.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(light.metaContents.get("color-scheme")).toBe("light");
    expect(light.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.light);

    const dark = createFakeBrowser({ stored: "dark", prefersDark: false });
    new Function(script)();
    expect(dark.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(dark.metaContents.get("color-scheme")).toBe("dark");
    expect(dark.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.dark);

    const autoDark = createFakeBrowser({ stored: "auto", prefersDark: true });
    new Function(script)();
    expect(autoDark.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(autoDark.metaContents.get("color-scheme")).toBe("dark");
    expect(autoDark.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.dark);

    const autoLight = createFakeBrowser({ stored: "auto", prefersDark: false });
    new Function(script)();
    expect(autoLight.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(autoLight.metaContents.get("color-scheme")).toBe("light");
    expect(autoLight.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.light);
  });

  it("returns SSR-safe dark snapshots by default", () => {
    function Probe() {
      const { colorScheme, resolvedColorScheme, osColorScheme } = useColorScheme();
      const computed = useComputedColorScheme();
      return el("span", null, `${colorScheme}:${resolvedColorScheme}:${computed}:${String(osColorScheme)}`);
    }
    const html = renderToStaticMarkup(el(ColorSchemeProvider, null, el(Probe)));
    expect(html).toBe("<span>dark:dark:dark:null</span>");
  });

  it.each(["/desktop", "/desktop/settings", "/desktop/activity", "/desktop/imports"])(
    "uses System for a fresh light appearance at %s before and after hydration",
    (pathname) => {
      const env = createFakeBrowser({ pathname, prefersDark: false });
      new Function(colorSchemeInitScript())();
      expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
      expect(env.metaContents.get("color-scheme")).toBe("light");
      expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.light);

      let latest = "";
      function Probe() {
        const { colorScheme, resolvedColorScheme } = useColorScheme();
        const computed = useComputedColorScheme();
        useEffect(() => {
          latest = `${colorScheme}:${resolvedColorScheme}:${computed}`;
        });
        return null;
      }
      const root = createRoot(env.fakeDocument.createElement("div") as unknown as Element);
      act(() => root.render(el(ColorSchemeProvider, { children: el(Probe) })));
      expect(latest).toBe("auto:light:light");
      act(() => env.dispatchStorage("dark"));
      expect(latest).toBe("auto:light:light");
      expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
      expect(env.storage.get(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
      act(() => env.setPrefersDark(true));
      expect(latest).toBe("auto:dark:dark");
      expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.dark);
      act(() => root.unmount());
    },
  );

  it("resolves colour schemes, updates meta tags, and bridges Mantine colorSchemeManager without recursion", () => {
    expect(resolveColorScheme("auto", "dark")).toBe("dark");
    expect(resolveColorScheme("light", "dark")).toBe("light");
    expect(resolveColorScheme("dark", "light")).toBe("dark");

    const env = createFakeBrowser({ stored: "dark", prefersDark: false });
    const manager = createMantineColorSchemeManager("dark");
    expect(manager.get("dark")).toBe("dark");

    // Simulate Mantine's subscribe callback calling manager.set back on every update.
    const seen: string[] = [];
    manager.subscribe((next) => {
      seen.push(next);
      manager.set(next);
    });

    manager.set("auto");
    expect(env.storage.get(COLOR_SCHEME_STORAGE_KEY)).toBe("auto");
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(env.metaContents.get("color-scheme")).toBe("light");
    expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.light);

    // OS switches to dark while scheme is auto: attribute and metas follow immediately.
    env.setPrefersDark(true);
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(env.metaContents.get("color-scheme")).toBe("dark");
    expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.dark);

    // Cross-tab storage update propagates once without recursing.
    env.dispatchStorage("light");
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(env.metaContents.get("color-scheme")).toBe("light");
    expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.light);
    expect(seen).toEqual(["light"]);

    manager.unsubscribe();
  });

  it("falls back to dark in both init script and provider when localStorage getter throws", () => {
    const script = colorSchemeInitScript();
    const env = createFakeBrowser({ prefersDark: false, throwOnStorageAccess: true });

    // Blocking head script resolves blocked storage to default dark before paint.
    new Function(script)();
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(env.metaContents.get("color-scheme")).toBe("dark");
    expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.dark);

    let latest = "";
    function Probe() {
      const { colorScheme, resolvedColorScheme, osColorScheme } = useColorScheme();
      const computed = useComputedColorScheme();
      useEffect(() => {
        latest = `${colorScheme}:${resolvedColorScheme}:${computed}:${osColorScheme}`;
      });
      return el("span", null, `${colorScheme}:${resolvedColorScheme}:${computed}`);
    }

    const container = env.fakeDocument.createElement("div");
    const root = createRoot(container as unknown as Element);

    act(() => {
      root.render(el(ColorSchemeProvider, { children: el(Probe) }));
    });

    expect(latest).toBe("dark:dark:dark:light");
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
    expect(env.metaContents.get("color-scheme")).toBe("dark");
    expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.dark);
    expect(createMantineColorSchemeManager().get("dark")).toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("applies the current stored value instead of a stale queued storage event newValue and ignores other keys", () => {
    const env = createFakeBrowser({ stored: "dark", prefersDark: false });
    const manager = createMantineColorSchemeManager("dark");
    const managerUpdates: string[] = [];
    manager.subscribe((next) => managerUpdates.push(next));

    let latestState = "";
    let latestSet: ((value: "light" | "dark" | "auto") => void) | null = null;
    function Probe() {
      const { colorScheme, resolvedColorScheme, setColorScheme } = useColorScheme();
      const computed = useComputedColorScheme();
      useEffect(() => {
        latestState = `${colorScheme}:${resolvedColorScheme}:${computed}`;
        latestSet = setColorScheme;
      });
      return el("span", null, `${colorScheme}:${resolvedColorScheme}:${computed}`);
    }

    const container = env.fakeDocument.createElement("div");
    const root = createRoot(container as unknown as Element);

    act(() => {
      root.render(el(ColorSchemeProvider, { children: el(Probe) }));
    });
    expect(latestState).toBe("dark:dark:dark");
    expect(manager.get("dark")).toBe("dark");
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");

    // This tab chooses light after another tab queued a dark storage event.
    act(() => {
      latestSet!("light");
    });
    expect(env.storage.get(COLOR_SCHEME_STORAGE_KEY)).toBe("light");
    expect(latestState).toBe("light:light:light");
    expect(manager.get("dark")).toBe("light");
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
    expect(env.metaContents.get("color-scheme")).toBe("light");
    expect(env.metaContents.get("theme-color")).toBe(THEME_COLOR_BY_SCHEME.light);

    // Stale queued dark event arrives while localStorage holds light: must stay light.
    act(() => {
      env.dispatchQueuedStorage("dark");
    });
    expect(latestState).toBe("light:light:light");
    expect(manager.get("dark")).toBe("light");
    expect(managerUpdates).toEqual(["light"]);
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");

    // Conversely, if storage now holds dark while state held light and a stale light event arrives, follow stored dark.
    env.storage.set(COLOR_SCHEME_STORAGE_KEY, "dark");
    act(() => {
      env.dispatchQueuedStorage("light");
    });
    expect(latestState).toBe("dark:dark:dark");
    expect(manager.get("dark")).toBe("dark");
    expect(managerUpdates).toEqual(["light", "dark"]);
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");

    // Unrelated keys must be ignored even if storage differs.
    env.storage.set(COLOR_SCHEME_STORAGE_KEY, "light");
    act(() => {
      env.dispatchQueuedStorage("light", "unrelated-key");
    });
    expect(latestState).toBe("dark:dark:dark");
    expect(manager.get("dark")).toBe("dark");
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");

    // Blocked storage during a storage event leaves current state untouched.
    env.setThrowOnGetItem(true);
    act(() => {
      env.dispatchQueuedStorage("light");
    });
    expect(latestState).toBe("dark:dark:dark");
    expect(manager.get("dark")).toBe("dark");
    expect(env.attrs.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");

    manager.unsubscribe();
    act(() => {
      root.unmount();
    });
  });
});
