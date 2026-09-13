// match_components (DESIGN.md §4): rank catalog components per region using structure, synonyms,
// role and the analyser's candidates; record confidence; where the top two are within 0.15,
// prepare one question. Visual similarity to the baselines is a later refinement.
import { rankComponents } from '../catalog/search.js';
import type { VersionData } from '../catalog/store.js';
import { childrenOf, type Layout, type Region } from './layout.js';

export interface Candidate { component: string; confidence: number; score: number; reasons: string[] }
export interface Assignment {
  regionId: string;
  role: string;
  label: string;
  component: string | null;
  confidence: number;
  candidates: Candidate[];
  source: 'auto' | 'answered' | 'unresolved' | 'none';
  note?: string;
}
export interface Question {
  key: string;
  regionId: string;
  message: string;
  options: Array<{ value: string; title: string }>;
  defaultValue: string;
}

const THRESHOLD = 0.15;
export const MAX_QUESTIONS = 8;

export function scoreRegion(data: VersionData, layout: Layout, region: Region): Candidate[] {
  const have = (id: string): boolean => data.byId.has(id) && data.byId.get(id)!.kind === 'component';
  const scores = new Map<string, { score: number; reasons: Set<string> }>();
  const add = (id: string, s: number, why: string): void => {
    if (!have(id)) return;
    const e = scores.get(id) ?? { score: 0, reasons: new Set<string>() };
    e.score += s;
    e.reasons.add(why);
    scores.set(id, e);
  };
  // Name/synonym ranking is relative: the best role match contributes 0.6, the best label match 0.2,
  // so the structural heuristics below can overrule wording.
  const byRole = rankComponents(data, region.role, 6);
  const roleTop = byRole[0]?.score || 1;
  for (const r of byRole) add(r.component.id, (0.6 * r.score) / roleTop, `role "${region.role}"`);
  if (region.label) { const byLabel = rankComponents(data, region.label, 4); const labelTop = byLabel[0]?.score || 1; for (const r of byLabel) add(r.component.id, (0.2 * r.score) / labelTop, 'label'); }
  region.candidates.forEach((id, i) => add(id, [0.5, 0.35, 0.2][i] ?? 0.1, 'analyser candidate'));

  const role = region.role;
  const text = region.text.join(' ').toLowerCase();
  const label = region.label.toLowerCase();
  const states = new Set(region.states);
  const kids = childrenOf(layout, region.id);
  const squarish = region.bounds.width > 0 && Math.abs(region.bounds.width - region.bounds.height) <= Math.max(8, region.bounds.width * 0.25);

  if (role === 'button' || role === 'icon-button') {
    if (states.has('icon-only') || (region.text.length === 0 && squarish)) { add('icon-button', 0.9, 'icon-only control'); add('button', -0.3, 'no visible label'); }
    else { add('button', 0.8, 'labelled action'); add('icon-button', -0.3, 'has a text label'); }
    if (/^(learn more|see all|view|read more)/.test(text) || states.has('link')) add('link', 0.3, 'navigational wording');
  }
  if (role === 'link') add('link', 0.8, 'link');
  if (role === 'heading' || role === 'title') add('heading', 0.8, 'heading');
  if (['text', 'paragraph', 'caption', 'body', 'label'].includes(role)) {
    add('text', 0.6, 'text block');
    const parent = region.parent ? layout.regions.find((r) => r.id === region.parent) : undefined;
    if (role === 'label' && parent && ['field', 'form', 'input'].includes(parent.role)) add('form-control', 0.5, 'field label');
  }
  if (role === 'field') { add('form-control', 0.8, 'labelled field'); if (kids.length) add('text-input', -0.3, 'contains the input; the wrapper is FormControl'); }
  if (['input', 'textbox', 'search'].includes(role)) {
    const cue = `${label} ${text}`;
    if (/date|calendar|when/.test(cue)) add('date-picker', 0.7, 'date cue');
    else if (/qty|quantity|amount|number|count/.test(cue)) add('number-input', 0.7, 'numeric cue');
    else if (/multi|message|description|notes|comment/.test(cue) || region.bounds.height > 60) add('textarea', 0.6, 'multi-line');
    else add('text-input', 0.7, 'single-line input');
    add('form-control', 0.25, 'inputs live in FormControl');
  }
  if (role === 'textarea') add('textarea', 0.8, 'textarea');
  if (['select', 'dropdown', 'combobox'].includes(role)) { add('select', 0.7, 'selection control'); add('menu', 0.25, 'could be an action menu'); }
  if (role === 'checkbox') add('checkbox', 0.8, 'checkbox');
  if (role === 'radio') add('radio-group', 0.8, 'radio');
  if (role === 'switch' || role === 'toggle') { add('switch', 0.7, 'toggle'); add('segmented-control', 0.2, 'or a segmented choice'); }
  if (['container', 'section', 'card', 'panel', 'page', 'group', 'box'].includes(role)) {
    if (role === 'card' || role === 'panel') add('card', 0.7, 'card-like');
    else if (role === 'page') { add('stack', 0.9, 'page root'); add('grid', 0.2, 'or a page grid'); }
    else {
      // The canonical ambiguity: a bordered block is a Card, a plain grouping is a Stack, and a block
      // with only a tinted background sits between the two — that one is asked about.
      const hasBorder = Boolean(region.style.borderColor);
      const hasBg = Boolean(region.style.background);
      if (hasBorder) { add('card', 0.6, 'has a border'); add('stack', 0.2, 'grouping'); }
      else if (hasBg) { add('card', 0.4, 'tinted background, no border'); add('stack', 0.4, 'could be a plain section'); }
      else { add('stack', 0.55, 'plain grouping'); add('card', 0.25, 'no surface'); }
      if (kids.length >= 3 && kids.every((k) => Math.abs(k.bounds.y - kids[0]!.bounds.y) < 12)) add('grid', 0.45, 'children in a row');
    }
  }
  if (role === 'row' || role === 'list') { add('stack', 0.5, 'linear group'); add('table', 0.35, 'or tabular'); }
  if (role === 'table') { add('table', 0.6, 'table'); add('data-table', 0.5, 'data table'); }
  if (states.has('sortable') || states.has('selectable') || /filter|sort/.test(`${label} ${text}`)) add('data-table', 0.35, 'sort/filter cue');
  if (['badge', 'tag', 'pill', 'chip', 'status'].includes(role)) {
    add('tag', 0.6, 'pill');
    add('badge', /^\d+$/.test(text.trim()) ? 0.7 : 0.45, /^\d+$/.test(text.trim()) ? 'numeric badge' : 'status pill');
  }
  if (role === 'empty-state') add('empty-state', 0.9, 'empty state');
  if (['nav', 'tabs', 'tab'].includes(role)) { add('tabs', 0.6, 'navigation tabs'); add('segmented-control', 0.3, 'or a segmented control'); }
  if (role === 'breadcrumb') add('breadcrumbs', 0.8, 'breadcrumb');
  if (role === 'pagination') add('pagination', 0.8, 'pagination');
  if (role === 'avatar') add('avatar', 0.8, 'avatar');
  if (role === 'icon') add('icon', 0.8, 'icon');
  if (role === 'divider' || role === 'separator') add('divider', 0.8, 'divider');
  if (['banner', 'alert', 'callout'].includes(role)) { add('banner', 0.7, 'inline message'); add('toast', 0.25, 'or transient'); }
  if (role === 'toast' || role === 'snackbar') add('toast', 0.8, 'toast');
  if (role === 'dialog' || role === 'modal') add('dialog', 0.8, 'dialog');
  if (role === 'menu') add('menu', 0.8, 'menu');
  if (role === 'tooltip') add('tooltip', 0.8, 'tooltip');
  if (role === 'progress') add('progress-bar', 0.8, 'progress');
  if (role === 'spinner' || states.has('loading')) { add('spinner', 0.5, 'loading'); add('skeleton', 0.3, 'or skeleton'); }
  if (role === 'popover') add('popover', 0.8, 'popover');
  if (role === 'image' || role === 'header' || role === 'footer' || role === 'sidebar') { /* no system component; Stack as the layout fallback */ if (role !== 'image') add('stack', 0.3, 'layout region'); }

  // A region with children is a container; leaf controls cannot hold them.
  const LEAF = new Set(['button', 'icon-button', 'link', 'heading', 'text', 'badge', 'tag', 'icon', 'avatar', 'divider', 'spinner', 'switch', 'checkbox', 'progress-bar', 'text-input', 'textarea', 'number-input', 'select', 'date-picker']);
  if (kids.length) for (const [id, e] of scores) if (LEAF.has(id)) e.score *= 0.5;
  const ranked = [...scores.entries()].filter(([, e]) => e.score > 0).map(([component, e]) => ({ component, score: Math.round(e.score * 100) / 100, reasons: [...e.reasons] })).sort((a, b) => b.score - a.score || a.component.localeCompare(b.component));
  const s1 = ranked[0]?.score ?? 0;
  const s2 = ranked[1]?.score ?? 0;
  const total = ranked.reduce((n, r) => n + r.score, 0) || 1;
  return ranked.slice(0, 4).map((r, i) => ({ ...r, confidence: Math.round((i < 2 ? r.score / (s1 + s2 + 0.1) : r.score / total) * 100) / 100 }));
}

export function assignRegions(data: VersionData, layout: Layout): Assignment[] {
  return layout.regions.map((region) => {
    const candidates = scoreRegion(data, layout, region);
    const top = candidates[0];
    if (!top) return { regionId: region.id, role: region.role, label: region.label, component: null, confidence: 0, candidates, source: 'none', note: `no system component for role "${region.role}"; keep as plain markup and flag for review` };
    return { regionId: region.id, role: region.role, label: region.label, component: top.component, confidence: top.confidence, candidates, source: 'auto' };
  });
}

/** Where the top two candidates are within the threshold, one question each, at most MAX_QUESTIONS. */
export function questionsFor(assignments: Assignment[], data: VersionData, layout: Layout, max = MAX_QUESTIONS): Question[] {
  const out: Question[] = [];
  for (const a of assignments) {
    const [c1, c2] = a.candidates;
    if (!c1 || !c2 || c1.confidence - c2.confidence >= THRESHOLD) continue;
    if (out.length >= max) break;
    const region = layout.regions.find((r) => r.id === a.regionId)!;
    const describe = (id: string, conf: number): string => {
      const c = data.byId.get(id);
      return `${c?.name ?? id} (${conf.toFixed(2)}): ${firstLine(c?.description) || id}`;
    };
    out.push({
      key: `region_${a.regionId}`,
      regionId: a.regionId,
      message: `Region ${a.regionId} (${region.label || region.role}${region.text[0] ? `, "${truncate(region.text[0], 40)}"` : ''}) matches two components.`,
      options: [...a.candidates.slice(0, 3).map((c) => ({ value: c.component, title: describe(c.component, c.confidence) })), { value: 'auto', title: 'Let the server decide' }],
      defaultValue: c1.component,
    });
  }
  return out;
}

const firstLine = (s: string | undefined): string => (s ?? '').split(/\n|\. /)[0]!.trim().slice(0, 90);
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
