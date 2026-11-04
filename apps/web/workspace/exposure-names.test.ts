import { describe, expect, it } from "vitest";
import { countryCode, countryName, industryName } from "./exposure-names";

describe("exposure names", () => {
  it("reads reported countries as one place with the app's Chinese names", () => {
    expect(countryCode("Taiwan Region")).toBe(countryCode("Taiwan"));
    expect(countryName("Taiwan Region", "zh")).toBe("台湾");
    expect(countryName("Hong Kong", "zh")).toBe("香港");
    expect(countryName("United States", "zh")).toBe("美国");
    expect(countryName("South Korea", "en")).toBe("South Korea");
    expect(countryName("Cash & derivatives", "zh")).toBe("现金与衍生品");
    expect(countryName("Atlantis", "zh")).toBe("Atlantis");
    expect(countryName(null, "zh")).toBe("—");
  });

  it("names GICS levels and look-through residuals in Chinese only", () => {
    expect(industryName("Information Technology", "zh")).toBe("信息技术");
    expect(industryName("Semiconductors", "zh")).toBe("半导体");
    expect(industryName("Technology Hardware, Storage & Peripherals", "zh")).toBe(
      "技术硬件、存储与外围设备",
    );
    expect(industryName("Not GICS applicable", "zh")).toBe("不适用 GICS");
    expect(industryName("Semiconductors", "en")).toBe("Semiconductors");
    expect(industryName("Quantum Widgets", "zh")).toBe("Quantum Widgets");
  });
});
