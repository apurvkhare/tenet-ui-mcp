// Size discipline (DESIGN.md §10): no response exceeds its cap. Trim, then say what was trimmed.

export const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/**
 * Shrink `value` under `cap` bytes: first clip long strings, then drop trailing items from the
 * largest arrays. Returns the (possibly trimmed) value and a note for the caller to surface.
 */
export function capJson<T extends Record<string, unknown>>(value: T, cap: number, hint: string): { value: T; truncated: boolean; note?: string } {
  if (bytes(value) <= cap) return { value, truncated: false };
  let v: Record<string, unknown> = structuredClone(value);
  const clip = (o: unknown, max: number): unknown => {
    if (typeof o === 'string') return o.length > max ? `${o.slice(0, max - 1)}…` : o;
    if (Array.isArray(o)) return o.map((x) => clip(x, max));
    if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, x]) => [k, clip(x, max)]));
    return o;
  };
  for (const max of [400, 200, 120]) {
    if (bytes(v) <= cap) break;
    v = clip(v, max) as Record<string, unknown>;
  }
  let guard = 0;
  while (bytes(v) > cap && guard++ < 200) {
    const arr = largestArray(v);
    if (!arr || arr.length <= 1) break;
    arr.pop();
  }
  return { value: v as T, truncated: true, note: `trimmed to fit ${cap} bytes; ${hint}` };
}

function largestArray(o: unknown, best: { arr: unknown[] | undefined; size: number } = { arr: undefined, size: 0 }): unknown[] | undefined {
  if (Array.isArray(o)) {
    const size = bytes(o);
    if (size > best.size) { best.arr = o; best.size = size; }
    for (const x of o) largestArray(x, best);
  } else if (o && typeof o === 'object') {
    for (const x of Object.values(o as Record<string, unknown>)) largestArray(x, best);
  }
  return best.arr;
}

export const firstSentence = (s: string | undefined, max = 160): string => {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  const cut = one.match(/^(.{20,}?[.!?])\s/)?.[1] ?? one;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
};
