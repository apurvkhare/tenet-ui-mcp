// resolve_tokens (DESIGN.md §4): every raw value the analyser read becomes the nearest token with
// its delta. Values beyond tolerance are decided here, never asked: a dimension snaps to the
// nearest step of its scale (the contract: every space, radius and font is a token); a colour
// snaps when it is near a semantic token and otherwise becomes a documented exception, because
// snapping a clearly different colour would change what it means. Each decision says why.
import { colorRoleFor, resolveValue, TOLERANCE, type Resolution, type Theme, type ValueKind } from '../catalog/resolve.js';
import type { VersionData } from '../catalog/store.js';
import type { Layout } from './layout.js';

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
  status: 'exact' | 'snapped' | 'exception';
  suggestion?: string;
  /** The nearest token after the pick, for an exception or a snap that was close. */
  runnerUp?: { token: string; cssVar: string; tokenValue: string; delta: number };
  /** Why a value beyond tolerance was snapped or kept, with the rule it follows. */
  decision?: { rule: string; reason: string; cites: string[] };
  note?: string;
}

const KIND_FOR: Record<string, ValueKind> = { background: 'color', color: 'color', borderColor: 'color', borderRadius: 'radius', fontSize: 'fontSize', fontWeight: 'fontWeight', gap: 'space', padding: 'space' };
/** A colour within this many times its ΔE tolerance is the same colour to the eye: snap. Beyond it, an exception. */
export const COLOR_SNAP_FACTOR = 2;
const COLOR_TOLERANCE = TOLERANCE.color!;

export function resolveLayoutTokens(data: VersionData, layout: Layout, theme: Theme, tolerance: Tolerance): { entries: TokenEntry[] } {
  const entries: TokenEntry[] = [];
  for (const region of layout.regions) {
    for (const [property, raw] of Object.entries(region.style)) {
      if (!raw) continue;
      const r = resolveValue(data.tokens, raw, KIND_FOR[property] ?? 'auto', theme, colorRoleFor(property));
      entries.push(decideValue(data, region.id, property, r, tolerance));
    }
  }
  return { entries };
}

function decideValue(data: VersionData, regionId: string, property: string, r: Resolution, tolerance: Tolerance): TokenEntry {
  const base = { regionId, property, raw: r.raw, kind: r.kind, delta: r.delta, runnerUp: r.alternatives?.[0] };
  const snapped = (rule: string, reason: string, topics: string[]): TokenEntry => ({ ...base, token: r.token, cssVar: r.cssVar, tokenValue: r.tokenValue, status: 'snapped', suggestion: r.suggestion, ...(rule ? { decision: { rule, reason, cites: cites(data, topics) } } : {}) });
  const exception = (rule: string, reason: string, topics: string[]): TokenEntry => ({ ...base, token: undefined, cssVar: undefined, status: 'exception', suggestion: r.raw, decision: { rule, reason, cites: cites(data, topics) }, note: r.token ? `nearest token ${r.cssVar} (${r.tokenValue}), Δ${r.delta}` : r.note });

  if (r.exact) return { ...base, token: r.token, cssVar: r.cssVar, tokenValue: r.tokenValue, status: 'exact', suggestion: r.suggestion };
  if (!r.token) return exception('no token', r.kind === 'unknown' ? 'the value kind could not be inferred, so there is no scale to snap to; keep it out of the component and document it' : `no ${r.kind} token matches${r.note ? ` (${r.note})` : ''}; documented exception`, ['contract']);
  if (tolerance === 'strict') return exception('tolerance strict', `strict tolerance keeps only exact matches; ${r.raw} is Δ${r.delta} from ${r.cssVar}`, ['contract']);
  if (r.withinTolerance) return snapped('', '', []);
  if (tolerance === 'loose') return snapped('tolerance loose', `loose tolerance snaps every value to its nearest token: ${r.cssVar} (${r.tokenValue}), Δ${r.delta}`, ['contract']);

  if (r.kind === 'color') {
    if ((r.delta ?? Infinity) <= COLOR_TOLERANCE * COLOR_SNAP_FACTOR) {
      return snapped('color §1: semantic tokens only', `ΔE ${r.delta} from ${r.cssVar} is within ${COLOR_SNAP_FACTOR}× the colour tolerance, the same colour to the eye; app code never writes a colour literal, so it snaps`, ['color', 'contract']);
    }
    return exception('color §1: no semantic token carries this colour', `ΔE ${r.delta} from the nearest semantic token ${r.cssVar} is a visibly different colour; snapping would change what it means, so it stays a documented exception for the design team (propose a token if it recurs)`, ['color', 'contract']);
  }
  // Space, radius, font size and weight: the scale is the law (contract, Styling; layout rule 2).
  return snapped('contract: every space, radius and font is a token', `${r.raw} is off the scale by ${r.delta}; the contract allows only scale steps, so it snaps to the nearest one, ${r.cssVar} (${r.tokenValue})${base.runnerUp ? `; next nearest ${base.runnerUp.cssVar} (${base.runnerUp.tokenValue}, Δ${base.runnerUp.delta})` : ''}`, r.kind === 'space' ? ['layout', 'contract'] : r.kind === 'fontSize' || r.kind === 'fontWeight' ? ['typography', 'contract'] : ['contract']);
}

function cites(data: VersionData, topics: string[]): string[] {
  const pages = new Set(data.guidelines?.pages.map((p) => p.id) ?? []);
  return topics.filter((t) => t === 'contract' || pages.has(t)).map((t) => `ds://${data.version}/guidelines/${t}`);
}
