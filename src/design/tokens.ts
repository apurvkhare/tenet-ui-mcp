// resolve_tokens (DESIGN.md §4): every raw value the analyser read becomes the nearest token with
// its delta; values beyond tolerance become exceptions or questions (snap, keep as exception, or
// propose a new token), batched, at most eight per call.
import { resolveValue, type Resolution, type Theme, type ValueKind } from '../catalog/resolve.js';
import type { VersionData } from '../catalog/store.js';
import type { Layout } from './layout.js';
import { MAX_QUESTIONS, type Question } from './match.js';

export type Tolerance = 'strict' | 'normal' | 'loose';

export interface TokenEntry {
  regionId: string;
  property: string;
  raw: string;
  kind: string;
  token?: string;
  cssVar?: string;
  tokenValue?: string;
  delta?: number;
  status: 'exact' | 'snapped' | 'exception' | 'pending' | 'proposed';
  suggestion?: string;
  alternatives?: Resolution['alternatives'];
  note?: string;
}

const KIND_FOR: Record<string, ValueKind> = { background: 'color', color: 'color', borderColor: 'color', borderRadius: 'radius', fontSize: 'fontSize', fontWeight: 'fontWeight', gap: 'space', padding: 'space' };

export function resolveLayoutTokens(data: VersionData, layout: Layout, theme: Theme, tolerance: Tolerance): { entries: TokenEntry[]; questions: Question[] } {
  const entries: TokenEntry[] = [];
  const seenRaw = new Map<string, TokenEntry>();
  for (const region of layout.regions) {
    for (const [property, raw] of Object.entries(region.style)) {
      if (!raw) continue;
      const kind = KIND_FOR[property] ?? 'auto';
      const r = resolveValue(data.tokens, raw, kind, theme);
      const snap = r.exact || (tolerance === 'loose' && r.token) || (tolerance === 'normal' && r.withinTolerance);
      const entry: TokenEntry = {
        regionId: region.id, property, raw, kind: r.kind, token: r.token, cssVar: r.cssVar, tokenValue: r.tokenValue, delta: r.delta,
        status: r.exact ? 'exact' : snap ? 'snapped' : r.token ? 'pending' : 'exception',
        suggestion: r.suggestion, alternatives: r.alternatives, note: r.note,
      };
      entries.push(entry);
      const key = `${kind}:${raw.toLowerCase()}`;
      if (!seenRaw.has(key)) seenRaw.set(key, entry);
    }
  }
  // One question per distinct off-scale value, not per region.
  const questions: Question[] = [];
  for (const [key, e] of seenRaw) {
    if (e.status !== 'pending' || questions.length >= MAX_QUESTIONS) continue;
    const regions = entries.filter((x) => `${KIND_FOR[x.property] ?? 'auto'}:${x.raw.toLowerCase()}` === key).map((x) => x.regionId);
    questions.push({
      key: `value_${questions.length + 1}`,
      regionId: e.regionId,
      message: `${e.raw} (${e.property} on ${regions.length === 1 ? `region ${regions[0]}` : `${regions.length} regions`}) is ${e.kind === 'color' ? `ΔE ${e.delta}` : `${e.delta} off`} from the nearest token ${e.cssVar}.`,
      options: [
        { value: `snap:${e.token}`, title: `Snap to ${e.cssVar} (${e.tokenValue})` },
        ...(e.alternatives ?? []).slice(0, 2).map((a) => ({ value: `snap:${a.token}`, title: `Use ${a.cssVar} (${a.tokenValue}, Δ${a.delta})` })),
        { value: 'exception', title: `Keep ${e.raw} as a documented exception` },
        { value: 'propose', title: 'Propose a new token to the design system' },
      ],
      defaultValue: `snap:${e.token}`,
    });
  }
  return { entries, questions };
}

/** Apply an answer to every entry sharing the answered value. */
export function applyTokenAnswer(entries: TokenEntry[], data: VersionData, answered: TokenEntry, choice: string): void {
  const same = entries.filter((x) => x.raw.toLowerCase() === answered.raw.toLowerCase() && (KIND_FOR[x.property] ?? 'auto') === (KIND_FOR[answered.property] ?? 'auto'));
  for (const e of same) {
    if (choice === 'exception') { e.status = 'exception'; e.token = undefined; e.cssVar = undefined; e.suggestion = e.raw; e.note = 'kept as an exception by the user'; }
    else if (choice === 'propose') { e.status = 'proposed'; e.suggestion = e.raw; e.note = 'user proposes a new token; keep the raw value with a TODO until the system adds it'; }
    else if (choice.startsWith('snap:')) {
      const name = choice.slice(5);
      const t = data.tokens.find((x) => x.name === name);
      if (t) { e.status = 'snapped'; e.token = t.name; e.cssVar = t.cssVar; e.tokenValue = String(t.themed ? t.light : t.value); e.suggestion = `var(${t.cssVar})`; e.note = 'snapped by the user'; }
    } else if (choice === 'auto') { e.status = e.token ? 'snapped' : 'exception'; e.note = 'auto-resolved'; }
  }
}
