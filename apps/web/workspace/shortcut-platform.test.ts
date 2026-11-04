import { describe, expect, it } from "vitest";
import { altDigitModifier } from "./shortcut-platform";

const agents = {
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  ubuntuFirefox: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  chromeOS: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  freeBSD: "Mozilla/5.0 (X11; FreeBSD amd64; rv:132.0) Gecko/20100101 Firefox/132.0",
};

describe("Alt and Option digit shortcuts", () => {
  it("bind on Apple devices with Option and on Windows with Alt, Firefox included", () => {
    expect([agents.macSafari, agents.macFirefox, agents.iphone].map(altDigitModifier)).toEqual(["⌥", "⌥", "⌥"]);
    expect([agents.windowsChrome, agents.windowsFirefox, agents.windowsEdge].map(altDigitModifier)).toEqual(["Alt", "Alt", "Alt"]);
  });

  it("leave Alt+digits to Linux browsers, ChromeOS and unknown platforms", () => {
    for (const agent of [agents.linuxFirefox, agents.ubuntuFirefox, agents.linuxChrome, agents.chromeOS, agents.android, agents.freeBSD, ""]) {
      expect(altDigitModifier(agent)).toBeNull();
    }
  });
});
