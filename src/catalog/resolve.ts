// Deterministic nearest-token resolution (DESIGN.md §6 resolve_value): shared by resolve_tokens
// and both audits. Colours are compared in CIE Lab (ΔE76); dimensions by absolute distance.
import type { TokenRecord } from '../ingest/extract/package-data.js';

export type ValueKind = 'color' | 'space' | 'fontSize' | 'radius' | 'borderWidth' | 'fontWeight' | 'lineHeight' | 'shadow' | 'fontFamily' | 'letterSpacing' | 'auto';
export type Theme = 'light' | 'dark';

export interface Resolution {
  raw: string;
  kind: Exclude<ValueKind, 'auto'> | 'unknown';
  token?: string;
  cssVar?: string;
  tokenValue?: string;
  /** ΔE for colours, px (or unitless) distance for dimensions. */
  delta?: number;
  exact: boolean;
  /** Below the kind's tolerance: snap without asking. */
  withinTolerance: boolean;
  /** `var(--space-3)` — what to write. */
  suggestion?: string;
  /** Next-best candidates, for elicitation. */
  alternatives?: Array<{ token: string; cssVar: string; tokenValue: string; delta: number }>;
  note?: string;
}

const GROUP_FOR_KIND: Record<Exclude<ValueKind, 'auto' | 'color' | 'unknown'>, string[]> = {
  space: ['space'],
  fontSize: ['fontSize'],
  radius: ['borderRadius'],
  borderWidth: ['borderWidth'],
  fontWeight: ['fontWeight'],
  lineHeight: ['lineHeight'],
  shadow: ['shadow'],
  fontFamily: ['fontFamily'],
  letterSpacing: ['letterSpacing'],
};
const TOLERANCE: Record<string, number> = { color: 4, space: 2, fontSize: 1, radius: 1, borderWidth: 0.5, fontWeight: 50, lineHeight: 0.1, letterSpacing: 0.02 };

export function resolveValue(tokens: TokenRecord[], raw: string, kind: ValueKind, theme: Theme): Resolution {
  const value = raw.trim();
  const k = kind === 'auto' ? inferKind(value) : kind;
  if (k === 'unknown' || k === 'auto') return { raw, kind: 'unknown', exact: false, withinTolerance: false, note: 'could not infer the value kind; pass `kind`' };
  if (k === 'color') return resolveColor(tokens, raw, value, theme);
  if (k === 'shadow' || k === 'fontFamily') return resolveExactString(tokens, raw, value, k);
  return resolveDimension(tokens, raw, value, k);
}

function inferKind(v: string): ValueKind | 'unknown' {
  if (parseColor(v)) return 'color';
  if (/^\d+(\.\d+)?(px|rem|em)$/.test(v)) return 'space';
  if (/^(100|200|300|400|500|600|700|800|900|bold|normal|semibold|medium)$/i.test(v)) return 'fontWeight';
  if (/^\d+(\.\d+)?$/.test(v)) return 'lineHeight';
  if (/rgba?\(|\d+px \d+px/.test(v)) return 'shadow';
  if (/,|serif|sans|mono/i.test(v)) return 'fontFamily';
  return 'unknown';
}

// ---- colours ---------------------------------------------------------------------------------
export function parseColor(v: string): [number, number, number] | undefined {
  const s = v.trim().toLowerCase();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const named: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], transparent: [255, 255, 255] };
  return named[s];
}

function toLab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export function deltaE(a: [number, number, number], b: [number, number, number]): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

function colorValue(t: TokenRecord, theme: Theme): string | undefined {
  const v = t.themed ? t[theme] : t.value;
  return typeof v === 'string' ? v : undefined;
}

function resolveColor(tokens: TokenRecord[], raw: string, value: string, theme: Theme): Resolution {
  const rgb = parseColor(value);
  if (!rgb) return { raw, kind: 'color', exact: false, withinTolerance: false, note: 'unparseable colour (hex, rgb() or a named colour expected)' };
  // Semantic tokens only: the base palette exists to be aliased, never used (typography.md / color.md).
  const candidates = tokens.filter((t) => t.type === 'color' && t.path?.[0] !== 'base');
  const scored = candidates
    .map((t) => { const v = colorValue(t, theme); const c = v ? parseColor(v) : undefined; return c ? { t, v: v!, d: deltaE(rgb, c) } : undefined; })
    .filter((x): x is { t: TokenRecord; v: string; d: number } => Boolean(x))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best) return { raw, kind: 'color', exact: false, withinTolerance: false, note: 'no colour tokens in this version' };
  const delta = Math.round(best.d * 100) / 100;
  return {
    raw,
    kind: 'color',
    token: best.t.name,
    cssVar: best.t.cssVar,
    tokenValue: best.v,
    delta,
    exact: delta === 0,
    withinTolerance: delta <= TOLERANCE.color!,
    suggestion: `var(${best.t.cssVar})`,
    alternatives: scored.slice(1, 4).map((s) => ({ token: s.t.name, cssVar: s.t.cssVar ?? '', tokenValue: s.v, delta: Math.round(s.d * 100) / 100 })),
    note: delta === 0 ? undefined : `nearest semantic token in ${theme}; ΔE ${delta}${delta > TOLERANCE.color! ? ' is beyond tolerance — an exception or a new token, not a silent snap' : ''}`,
  };
}

// ---- dimensions ------------------------------------------------------------------------------
function parseNumber(v: string, kind: string): number | undefined {
  const m = v.match(/^(-?\d+(?:\.\d+)?)(px|rem|em|%)?$/);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === 'rem' || m[2] === 'em') return n * 16;
    if (m[2] === '%') return undefined;
    return n;
  }
  if (kind === 'fontWeight') {
    const words: Record<string, number> = { normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700 };
    return words[v.toLowerCase()];
  }
  return undefined;
}

function resolveDimension(tokens: TokenRecord[], raw: string, value: string, kind: Exclude<ValueKind, 'auto' | 'color' | 'shadow' | 'fontFamily'>): Resolution {
  const n = parseNumber(value, kind);
  if (n === undefined) return { raw, kind, exact: false, withinTolerance: false, note: `unparseable ${kind} value` };
  const groups = GROUP_FOR_KIND[kind];
  const scored = tokens
    .filter((t) => groups.includes(t.path?.[0] ?? ''))
    .map((t) => { const tv = typeof t.value === 'string' || typeof t.value === 'number' ? String(t.value) : undefined; const tn = tv !== undefined ? parseNumber(tv, kind) : undefined; return tn === undefined ? undefined : { t, v: tv!, d: Math.abs(tn - n) }; })
    .filter((x): x is { t: TokenRecord; v: string; d: number } => Boolean(x))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best) return { raw, kind, exact: false, withinTolerance: false, note: `no ${groups.join('/')} tokens in this version` };
  const delta = Math.round(best.d * 100) / 100;
  const tol = TOLERANCE[kind] ?? 0;
  return {
    raw,
    kind,
    token: best.t.name,
    cssVar: best.t.cssVar,
    tokenValue: best.v,
    delta,
    exact: delta === 0,
    withinTolerance: delta <= tol,
    suggestion: `var(${best.t.cssVar})`,
    alternatives: scored.slice(1, 3).map((s) => ({ token: s.t.name, cssVar: s.t.cssVar ?? '', tokenValue: s.v, delta: Math.round(s.d * 100) / 100 })),
    note: delta === 0 ? undefined : `${value} is off the ${groups[0]} scale by ${delta}${kind === 'fontWeight' || kind === 'lineHeight' ? '' : 'px'}; ${delta <= tol ? 'snap' : 'keep as an exception or ask'}`,
  };
}

function resolveExactString(tokens: TokenRecord[], raw: string, value: string, kind: 'shadow' | 'fontFamily'): Resolution {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').replace(/['"]/g, '').trim().toLowerCase();
  const groups = GROUP_FOR_KIND[kind];
  const hit = tokens.find((t) => groups.includes(t.path?.[0] ?? '') && typeof t.value === 'string' && norm(t.value) === norm(value));
  if (hit) return { raw, kind, token: hit.name, cssVar: hit.cssVar, tokenValue: String(hit.value), delta: 0, exact: true, withinTolerance: true, suggestion: `var(${hit.cssVar})` };
  const options = tokens.filter((t) => groups.includes(t.path?.[0] ?? '')).map((t) => ({ token: t.name, cssVar: t.cssVar ?? '', tokenValue: String(t.value), delta: 1 }));
  return { raw, kind, exact: false, withinTolerance: false, alternatives: options.slice(0, 4), note: `no ${kind} token matches; pick one of the ${options.length} defined` };
}
