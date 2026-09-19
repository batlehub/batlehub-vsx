// The colour maths the theme is built and tested with: sRGB, WCAG relative
// luminance, and the OKLCH lightness re-derivation DESIGN.md's Re-Derived
// Lightness Rule asks for. No dependency — the formulas are the spec.
//
// A colour is { r, g, b, a } with r/g/b in 0..255 and a in 0..1.

/** "#rgb" | "#rgba" | "#rrggbb" | "#rrggbbaa" → { r, g, b, a }. */
export function parseHex(hex) {
  const s = String(hex).trim();
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8)
    throw new Error(`not a hex colour: ${hex}`);
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const hex2 = (n) =>
  Math.min(255, Math.max(0, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

/** Lower case, 6 digits when opaque, 8 when not — the form the JSON carries. */
export function toHex(c) {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a >= 1 ? base : base + hex2(c.a * 255);
}

const lin = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance. */
export function luminance(c) {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** `fg` painted on `bg`; alpha is composited before measuring, as the eye sees it. */
export function contrast(fg, bg) {
  const f = luminance(composite(fg, bg));
  const b = luminance(bg);
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}

/** Source-over of `fg` on an opaque `bg`. */
export function composite(fg, bg) {
  if (fg.a >= 1) return { ...fg, a: 1 };
  const k = fg.a;
  return {
    r: fg.r * k + bg.r * (1 - k),
    g: fg.g * k + bg.g * (1 - k),
    b: fg.b * k + bg.b * (1 - k),
    a: 1,
  };
}

// ── HSL, for the darken/lighten/lessProminent transforms of the editor's own
// colour registry (base-defaults.mjs reproduces them to resolve the defaults).

export function toHsl(c) {
  const r = c.r / 255,
    g = c.g / 255,
    b = c.b / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (min + max) / 2;
  const chroma = max - min;
  let h = 0,
    s = 0;
  if (chroma > 0) {
    s = l <= 0.5 ? chroma / (max + min) : chroma / (2 - max - min);
    if (max === r) h = ((g - b) / chroma) % 6;
    else if (max === g) h = (b - r) / chroma + 2;
    else h = (r - g) / chroma + 4;
    h = Math.min(Math.max(h * 60, 0), 360);
    if (h < 0) h += 360;
  }
  return { h, s, l, a: c.a };
}

export function fromHsl({ h, s, l, a }) {
  h = (h % 360) / 60;
  const byte = (v) => Math.min(255, Math.max(0, Math.round(v * 255)));
  if (s === 0) {
    const v = byte(l);
    return { r: v, g: v, b: v, a };
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const i = Math.floor(h);
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][i % 6];
  return { r: byte(r + m), g: byte(g + m), b: byte(b + m), a };
}

export const lighten = (c, f) => {
  const h = toHsl(c);
  return fromHsl({ ...h, l: h.l + h.l * f });
};
export const darken = (c, f) => {
  const h = toHsl(c);
  return fromHsl({ ...h, l: h.l - h.l * f });
};
export const transparent = (c, f) => ({ ...c, a: c.a * f });

// ── OKLCH, for the Re-Derived Lightness Rule.

const M1 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const M2 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
const M3 = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const M4 = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];
const mul = (m, v) =>
  m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const srgbToLinear = (v) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

export function toOklab(c) {
  const rgb = [c.r, c.g, c.b].map((v) => srgbToLinear(v / 255));
  const lms = mul(M1, rgb).map(Math.cbrt);
  const [L, a, b] = mul(M2, lms);
  return { L, a, b };
}

export function toOklch(c) {
  const { L, a, b } = toOklab(c);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C: Math.hypot(a, b), h };
}

/** OKLCH → sRGB, each channel clamped: the In-Gamut Rule applied at the edge. */
export function fromOklch({ L, C, h }, alpha = 1) {
  const rad = (h * Math.PI) / 180;
  const lms = mul(M3, [L, C * Math.cos(rad), C * Math.sin(rad)]).map(
    (v) => v ** 3,
  );
  const rgb = mul(M4, lms).map((v) =>
    Math.round(
      Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))) * 255,
    ),
  );
  return { r: rgb[0], g: rgb[1], b: rgb[2], a: alpha };
}

/** OKLCH → sRGB with chroma dropped only as far as the gamut forces. */
export function fromOklchClamped({ L, C, h }, alpha = 1) {
  let c = C;
  while (c > 0 && !inGamut({ L, C: c, h })) c -= 0.002;
  return fromOklch({ L, C: Math.max(0, c), h }, alpha);
}

/** True when the OKLCH triple survives the round trip to sRGB — In-Gamut Rule. */
export function inGamut({ L, C, h }) {
  const rad = (h * Math.PI) / 180;
  const lms = mul(M3, [L, C * Math.cos(rad), C * Math.sin(rad)]).map(
    (v) => v ** 3,
  );
  return mul(M4, lms).every((v) => v >= -0.0005 && v <= 1.0005);
}

/**
 * DESIGN.md's Re-Derived Lightness Rule: the hue survives the crossing, the
 * lightness does not. Move `c`'s OKLCH lightness — whichever way is shorter —
 * until it measures `target` against every background in `bgs`, keeping hue
 * and dropping chroma only as far as the sRGB gamut forces. Returns `c`
 * unchanged when it already holds, and throws when no lightness of that hue
 * reaches the target on all of them.
 */
export function reLightnessOn(c, bgs, target) {
  const holds = (x) => bgs.every((b) => contrast(x, b) >= target - 1e-9);
  if (holds(c)) return c;
  const { L: L0, C, h } = toOklch(c);
  let best = null;
  for (const dir of [1, -1]) {
    for (let i = 1; i <= 200; i++) {
      const L = Math.min(1, Math.max(0, L0 + dir * i * 0.005));
      const moved = fromOklchClamped({ L, C, h }, c.a);
      if (holds(moved)) {
        if (!best || i < best.i) best = { i, moved };
        break;
      }
      if (L === 0 || L === 1) break;
    }
  }
  if (!best)
    throw new Error(
      `no lightness of hue ${h.toFixed(1)} reaches ${target}:1 on ${bgs.map(toHex).join(", ")}`,
    );
  return best.moved;
}

export const reLightness = (c, bg, target) => reLightnessOn(c, [bg], target);

/** ΔE in OKLab: the distance the eye reads between two hues. */
export function deltaE(a, b) {
  const x = toOklab(a),
    y = toOklab(b);
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}
