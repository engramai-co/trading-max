type Channels = readonly [red: number, green: number, blue: number, alpha: number];

let probe: CanvasRenderingContext2D | null | undefined;

function clamp(value: number, max = 1) {
  return Math.min(max, Math.max(0, value));
}

function rgb([red, green, blue, alpha]: Channels): string {
  const channels = [red, green, blue].map((value) => Math.round(clamp(value, 255))).join(", ");
  return alpha === 1 ? `rgb(${channels})` : `rgba(${channels}, ${Number(alpha.toFixed(4))})`;
}

function readNumber(token: string, percentageOf = 1): number {
  if (token === "none") return 0;
  return token.endsWith("%") ? Number(token.slice(0, -1)) * percentageOf / 100 : Number(token);
}

function readHex(value: string): Channels | undefined {
  if (!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return undefined;
  const hex = value.slice(1);
  const bytes = hex.length <= 4 ? [...hex].map((digit) => digit + digit) : hex.match(/../g)!;
  const [r, g, b, a = 255] = bytes.map((byte) => Number.parseInt(byte, 16));
  return [r, g, b, a / 255];
}

function readRgb(value: string): Channels | undefined {
  const hex = readHex(value);
  if (hex) return hex;
  const match = /^rgba?\((.*)\)$/i.exec(value);
  if (!match) return undefined;
  const parts = match[1].trim().split(/[\s,/]+/);
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const [r, g, b, a = "1"] = parts;
  const channels = [readNumber(r, 255), readNumber(g, 255), readNumber(b, 255), clamp(readNumber(a))] as const;
  return channels.every(Number.isFinite) ? channels : undefined;
}

function toSrgb(linear: number): number {
  const channel = clamp(linear);
  return 255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055);
}

function readOklch(value: string): Channels | undefined {
  const match = /^oklch\(([^()]*)\)$/i.exec(value);
  if (!match) return undefined;
  const [lightness, chroma, hue, alpha = "1"] = match[1].trim().split(/[\s/]+/);
  const angle = /^([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(hue);
  if (hue !== "none" && !angle) return undefined;
  const radiansPerUnit = { deg: Math.PI / 180, rad: 1, grad: Math.PI / 200, turn: 2 * Math.PI };
  const unit = (angle?.[2]?.toLowerCase() ?? "deg") as keyof typeof radiansPerUnit;
  const radians = Number(angle?.[1] ?? 0) * radiansPerUnit[unit];
  const L = clamp(readNumber(lightness));
  const C = Math.max(0, readNumber(chroma, 0.4));
  const opacity = clamp(readNumber(alpha));
  if (![L, C, radians, opacity].every(Number.isFinite)) return undefined;

  const a = C * Math.cos(radians);
  const b = C * Math.sin(radians);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    opacity,
  ];
}

function resolveInBrowser(value: string): Channels | undefined {
  if (typeof document === "undefined") return undefined;
  if (probe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!probe) return undefined;
  // The canvas setter ignores invalid values. Probe against two colours so
  // a valid keyword that serializes to either sentinel still resolves.
  probe.fillStyle = rgb([1, 2, 3, 1]);
  const first = probe.fillStyle;
  probe.fillStyle = value;
  if (probe.fillStyle === first) {
    probe.fillStyle = rgb([4, 5, 6, 1]);
    const second = probe.fillStyle;
    probe.fillStyle = value;
    if (probe.fillStyle === second) return undefined;
  }
  const channels = readRgb(String(probe.fillStyle));
  if (channels) return channels;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

/** The CSS cascade resolves aliases. ZRender needs the resulting colour in legacy sRGB syntax. */
export function toCanvasColour(computed: string): string {
  const value = computed.trim();
  if (!value || value.startsWith("var(")) return "";
  if (value === "transparent") return value;
  const channels = readRgb(value) ?? resolveInBrowser(value) ?? readOklch(value);
  return channels ? rgb(channels) : "";
}

export function withCanvasAlpha(colour: string, alpha: number): string {
  const channels = readRgb(colour);
  return channels ? rgb([channels[0], channels[1], channels[2], clamp(channels[3] * alpha)]) : colour;
}

/** The overlay token defines x, y and blur in px followed by the shadow colour. */
export function canvasShadow(token: string) {
  const [x, y, blur, colour] = /^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?\s+(.+)$/.exec(token.trim())?.slice(1) ?? [];
  if (!colour) return {};
  return {
    shadowOffsetX: Number(x),
    shadowOffsetY: Number(y),
    shadowBlur: Number(blur),
    shadowColor: toCanvasColour(colour),
  };
}
