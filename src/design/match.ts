// match_components (DESIGN.md §4): rank catalog components per region using structure, synonyms,
// role and the analyser's candidates; record confidence. Where the top two are within 0.15 the
// server decides: the guideline tests below settle the pair from structural cues, and the result
// names the pick, the rule it applied, the confidence and the runner-up. It never asks the user.
// Visual similarity to the baselines is a later refinement.
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
  /** auto: a clear winner; decided: a close call the server settled (see `decision`); none: no system component. */
  source: 'auto' | 'decided' | 'none';
  decision?: Decision;
  note?: string;
}
/** How a close call was settled: by a guideline test, or (when no test applies) by the higher score. */
export interface Decision {
  basis: 'guideline' | 'score';
  rule: string;
  reason: string;
  cites: string[];
  runnerUp: { component: string; confidence: number };
}

/** Top two within this are a close call, settled by `decide`. */
export const CLOSE_CALL = 0.15;
/** Confidence of a pick that a guideline test settled. */
const GUIDELINE_CONFIDENCE = 0.85;

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
  const byId = new Map<string, Assignment>();
  // Parents before children, so a child's decision can see what its ancestors became.
  const visit = (parent: string | null): void => {
    for (const region of childrenOf(layout, parent)) {
      const candidates = scoreRegion(data, layout, region);
      const top = candidates[0];
      const a: Assignment = top
        ? { regionId: region.id, role: region.role, label: region.label, component: top.component, confidence: top.confidence, candidates, source: 'auto' }
        : { regionId: region.id, role: region.role, label: region.label, component: null, confidence: 0, candidates, source: 'none', note: `no system component for role "${region.role}"; keep as plain markup and flag for review` };
      const second = candidates[1];
      if (top && second && top.confidence - second.confidence < CLOSE_CALL) {
        const d = decide(data, layout, region, top, second, byId);
        a.component = d.pick;
        a.confidence = d.basis === 'guideline' ? Math.max(GUIDELINE_CONFIDENCE, top.confidence) : top.confidence;
        a.source = 'decided';
        a.decision = { basis: d.basis, rule: d.rule, reason: d.reason, cites: d.cites, runnerUp: d.pick === top.component ? { component: second.component, confidence: second.confidence } : { component: top.component, confidence: top.confidence } };
      }
      byId.set(region.id, a);
      visit(region.id);
    }
  };
  visit(null);
  // Regions whose parent is missing from the layout are still assigned, in input order.
  for (const region of layout.regions) if (!byId.has(region.id)) { byId.set(region.id, { regionId: region.id, role: region.role, label: region.label, component: null, confidence: 0, candidates: [], source: 'none', note: 'parent region not found in the layout' }); }
  return layout.regions.map((r) => byId.get(r.id)!);
}

// ---- deciding close calls --------------------------------------------------------------------------
interface Verdict { pick: string; basis: 'guideline' | 'score'; rule: string; reason: string; cites: string[] }
interface Cues { region: Region; kids: Region[]; ancestors: Array<{ region: Region; component: string | null }>; siblings: Region[]; layout: Layout }
interface Rule {
  /** Applies when the close pair is exactly these two components (in either order); `*` matches any. */
  pair: [string, string];
  rule: string;
  topics: string[];
  test: (c: Cues, pair: [string, string]) => { pick: string; reason: string } | undefined;
}

const ACTION_ROLES = new Set(['button', 'icon-button', 'link']);
const isHeading = (r: Region): boolean => r.role === 'heading' || r.role === 'title';
const near = (a: number, b: number): boolean => b > 0 && Math.abs(a - b) / b <= 0.15;
const other = (pair: [string, string], id: string): string => (pair[0] === id ? pair[1] : pair[0]);

/** Card vs a plain section: the test in ds://…/guidelines/layout (rules 9 and 10) and card. */
const cardTest = (layoutPick: string): Rule['test'] => (c) => {
  const plain = layoutPick;
  const inCard = c.ancestors.find((a) => a.component === 'card');
  if (inCard) return { pick: plain, reason: `inside ${inCard.region.id}, which is a Card; a Card never contains another Card (layout rule 10)` };
  const vw = c.layout.viewport?.width ?? 0;
  if (c.region.role === 'page' || (!c.region.parent && vw > 0 && c.region.bounds.width >= vw * 0.9)) return { pick: plain, reason: 'it wraps the page; a page is never a single full-width Card (layout rule 10)' };
  const tiles = c.siblings.filter((s) => s.role === c.region.role && near(s.bounds.width, c.region.bounds.width) && near(s.bounds.height, c.region.bounds.height));
  if (tiles.length >= 1) return { pick: 'card', reason: `one of ${tiles.length + 1} repeated tiles of the same size; summary tiles are Cards (layout rule 10)` };
  const heading = c.kids.find(isHeading);
  const action = c.kids.find((k) => ACTION_ROLES.has(k.role));
  if (heading || action) return { pick: 'card', reason: `it has its own ${heading && action ? 'heading and action' : heading ? 'heading' : 'action'}, so it is a self-contained object that makes sense lifted out of the page (layout rule 9)` };
  if (!c.region.style.borderColor) return { pick: plain, reason: 'no border and no heading or action of its own: it flows with the page, and removing the surface would lose nothing, so it is a plain section (layout rule 9)' };
  return { pick: 'card', reason: 'a bordered surface is the Card\'s job; never a styled element with a hardcoded border (card guideline)' };
};

const RULES: Rule[] = [
  {
    pair: ['stack', '*'], rule: 'layout: a page is a Stack of sections', topics: ['layout', 'stack'],
    test: (c) => (c.region.role === 'page' ? { pick: 'stack', reason: 'it is the page root; a page is `<Stack gap="spacious">` of sections (layout, page row)' } : undefined),
  },
  { pair: ['card', 'stack'], rule: 'layout §9-10: Card or plain section', topics: ['layout', 'card'], test: cardTest('stack') },
  { pair: ['card', 'grid'], rule: 'layout §9-10: Card or plain section', topics: ['layout', 'card'], test: cardTest('grid') },
  {
    pair: ['badge', 'tag'], rule: 'badge: count or dot vs a labelled status word', topics: ['badge', 'tag'],
    test: (c) => { const t = c.region.text.join(' ').trim(); return /^\d+\+?$/.test(t) || t === '' ? { pick: 'badge', reason: t ? `"${t}" is a count; a compact count or presence dot is a Badge` : 'no text: a presence dot is a Badge' } : { pick: 'tag', reason: `"${t.slice(0, 30)}" is a word; a labelled status word is a Tag, not a Badge` }; },
  },
  {
    pair: ['menu', 'select'], rule: 'menu: actions vs picking a value', topics: ['menu', 'select'],
    test: (c) => { const cue = `${c.region.label} ${c.region.text.join(' ')}`.toLowerCase(); const inForm = c.ancestors.some((a) => ['field', 'form'].includes(a.region.role) || a.component === 'form-control'); return !inForm && /\b(actions?|more|options)\b|⋯|…|\.\.\./.test(cue) ? { pick: 'menu', reason: 'it triggers actions (overflow or action wording) outside a form; a list of actions is a Menu' } : { pick: 'select', reason: inForm ? 'it picks a value inside a field; for picking a value use Select' : 'nothing marks it as a list of actions; it picks a value, which is Select' }; },
  },
  {
    pair: ['segmented-control', 'tabs'], rule: 'segmented-control: 2 to 5 modes vs peer views', topics: ['segmented-control', 'tabs'],
    test: (c) => { const n = c.kids.length || c.region.text.length; const states = new Set(c.region.states); if (n > 5) return { pick: 'tabs', reason: `${n} options; a SegmentedControl holds 2 to 5` }; return states.has('toggle') || states.has('mode') ? { pick: 'segmented-control', reason: 'a few mutually exclusive modes that take effect immediately are a SegmentedControl' } : { pick: 'tabs', reason: 'switching between peer views of the same context is Tabs' }; },
  },
  {
    pair: ['switch', 'segmented-control'], rule: 'segmented-control: on/off is a Switch', topics: ['segmented-control', 'switch'],
    test: (c) => (c.kids.length > 2 || c.region.text.length > 2 ? { pick: 'segmented-control', reason: 'more than two choices; on/off is a Switch, several modes are a SegmentedControl' } : { pick: 'switch', reason: 'a single on/off choice is a Switch' }),
  },
  {
    pair: ['banner', 'toast'], rule: 'banner: anchored to content vs transient', topics: ['banner', 'toast'],
    test: (c) => { const s = new Set(c.region.states); return s.has('transient') || s.has('floating') ? { pick: 'toast', reason: 'transient, floating feedback is a toast' } : { pick: 'banner', reason: 'it sits in the content flow; a message anchored to the content it describes is a Banner' }; },
  },
  {
    pair: ['button', 'link'], rule: 'link: a link navigates, a button acts', topics: ['link', 'button'],
    test: (c) => { const t = c.region.text.join(' ').toLowerCase(); return c.region.states.includes('link') || /^(learn more|see all|view|read more|go to|open )/.test(t) ? { pick: 'link', reason: 'navigational wording; a link navigates, a button acts' } : { pick: 'button', reason: 'it performs an action; a button acts, a link navigates' }; },
  },
  {
    pair: ['button', 'icon-button'], rule: 'icon-button: no visible label', topics: ['icon-button', 'button'],
    test: (c) => (c.region.text.length === 0 || c.region.states.includes('icon-only') ? { pick: 'icon-button', reason: 'no visible text label; an icon-only control is an IconButton with an aria-label' } : { pick: 'button', reason: 'it has a visible text label, so it is a Button' }),
  },
  {
    pair: ['data-table', 'table'], rule: 'data-table: sorting, filtering or selection', topics: ['data-table', 'table'],
    test: (c) => { const s = new Set(c.region.states); return s.has('sortable') || s.has('selectable') || s.has('paginated') || /filter|sort|search/.test(`${c.region.label} ${c.region.text.join(' ')}`.toLowerCase()) ? { pick: 'data-table', reason: 'it sorts, filters or selects rows, which is DataTable' } : { pick: 'table', reason: 'static rows without sorting, filtering or selection are a Table' }; },
  },
];

function decide(data: VersionData, layout: Layout, region: Region, top: Candidate, second: Candidate, assigned: Map<string, Assignment>): Verdict {
  const ancestors: Cues['ancestors'] = [];
  for (let p = region.parent; p; ) { const r = layout.regions.find((x) => x.id === p); if (!r) break; ancestors.push({ region: r, component: assigned.get(r.id)?.component ?? null }); p = r.parent; }
  const cues: Cues = { region, kids: childrenOf(layout, region.id), ancestors, siblings: childrenOf(layout, region.parent ?? null).filter((s) => s.id !== region.id), layout };
  const pair: [string, string] = [top.component, second.component];
  for (const rule of RULES) {
    if (!rule.pair.every((id) => id === '*' || pair.includes(id))) continue;
    const v = rule.test(cues, pair);
    if (v && pair.includes(v.pick)) return { pick: v.pick, basis: 'guideline', rule: rule.rule, reason: v.reason, cites: cites(data, rule.topics) };
  }
  return {
    pick: top.component,
    basis: 'score',
    rule: 'structural score',
    reason: `no guideline test separates ${nameOf(data, top.component)} from ${nameOf(data, other(pair, top.component))} here; picked the higher structural score (${top.score} vs ${second.score}: ${top.reasons.slice(0, 2).join(', ')})`,
    cites: cites(data, [top.component]),
  };
}

const nameOf = (data: VersionData, id: string): string => data.byId.get(id)?.name ?? id;
/** Guideline URIs the agent can read; the contract stands in when a page is missing. */
function cites(data: VersionData, topics: string[]): string[] {
  const pages = new Set(data.guidelines?.pages.map((p) => p.id) ?? []);
  const out = topics.filter((t) => pages.has(t)).map((t) => `ds://${data.version}/guidelines/${t}`);
  return out.length ? out : [`ds://${data.version}/guidelines/contract`];
}
