// audit_page judgment (DESIGN.md §5 "audit_page (runtime)", rev 3): over a snapshot the host
// captured with the skill's capture script (`capture.mjs page`). Computed values that resolve to
// no token for the theme, contrast against the documented pairs, accessibility-tree problems,
// focus order against visual order. The server never fetches a page.
import { z } from 'zod';
import { parseColor, resolveValue, type Theme } from '../catalog/resolve.js';
import type { VersionData } from '../catalog/store.js';
import { axeFindings } from './judge.js';
import type { CheckStatus } from './report.js';
import type { Finding, Severity } from './static.js';

const Element = z.object({
  path: z.string(),
  /** Index of the nearest recorded ancestor in elements[] (capture ≥ 0.1.1); null for body. */
  parent: z.number().int().nullable().optional(),
  tag: z.string(),
  id: z.string().optional(),
  className: z.string().optional(),
  role: z.string().optional(),
  ariaLabel: z.string().optional(),
  text: z.string().optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  styles: z.record(z.string(), z.string()),
});
export type SnapshotElement = z.infer<typeof Element>;

export const SnapshotSchema = z.object({
  schemaVersion: z.number().optional(),
  tool: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  capturedAt: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  theme: z.string().nullable().optional(),
  runtimeContract: z.object({ stylesheetLoaded: z.boolean(), missingTokens: z.array(z.string()).optional(), colorMode: z.string().nullable().optional() }).nullable().optional(),
  screenshot: z.object({ file: z.string().optional(), sha256: z.string().optional(), bytes: z.number().optional(), data: z.string().optional() }).optional(),
  a11yTree: z.object({ format: z.string(), tree: z.unknown() }).optional(),
  computedStyles: z.object({ count: z.number().optional(), elements: z.array(Element).max(5000) }).optional(),
  axe: z.object({ tags: z.array(z.string()).optional(), violations: z.array(z.object({ id: z.string(), impact: z.string().optional(), help: z.string().optional(), helpUrl: z.string().optional(), nodes: z.array(z.object({ target: z.string(), html: z.string().optional(), summary: z.string().optional() })) })) }).optional(),
  consoleErrors: z.array(z.string()).optional(),
});
export type PageSnapshot = z.infer<typeof SnapshotSchema>;

export const PAGE_CHECKS = ['runtime', 'tokens', 'contrast', 'a11y', 'visual'] as const;
export type PageCheck = (typeof PAGE_CHECKS)[number];

export interface PageJudgement {
  findings: Finding[];
  checks: Record<string, CheckStatus>;
  stats: Record<string, number>;
}

const fid = (parts: Array<string | number | undefined>): string => parts.filter((p) => p !== undefined && p !== '').join('|');
const TRANSPARENT = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$|^transparent$/;
const NAME_ROLES: Record<string, Severity> = { button: 'critical', link: 'critical', img: 'critical', textbox: 'serious', combobox: 'serious', checkbox: 'serious', radio: 'serious', switch: 'serious', slider: 'serious', spinbutton: 'serious', searchbox: 'serious', tab: 'serious', menuitem: 'serious' };
const ROLE_FIX: Record<string, { hint: string; primitive?: string; axe: string }> = {
  button: { hint: 'text children, or aria-label on IconButton', primitive: 'IconButton', axe: 'button-name' },
  link: { hint: 'visible link text that names the destination', primitive: 'Link', axe: 'link-name' },
  img: { hint: 'alt describing the image, or alt="" if decorative — never guess', axe: 'image-alt' },
  textbox: { hint: 'wrap in FormControl with FormControl.Label', primitive: 'FormControl', axe: 'label' },
  combobox: { hint: 'wrap Select in FormControl with a Label', primitive: 'FormControl', axe: 'select-name' },
  checkbox: { hint: 'Checkbox takes a label prop', primitive: 'Checkbox', axe: 'label' },
  radio: { hint: 'Radio takes a label prop', primitive: 'RadioGroup', axe: 'label' },
  switch: { hint: 'Switch takes a label prop', primitive: 'Switch', axe: 'label' },
  tab: { hint: 'Tabs.Tab needs text children', primitive: 'Tabs', axe: 'aria-required-children' },
  menuitem: { hint: 'Menu.Item needs text children', primitive: 'Menu', axe: 'aria-required-children' },
};

export function judgePage(data: VersionData, snap: PageSnapshot, theme: Theme, wanted: ReadonlySet<PageCheck>): PageJudgement {
  const findings: Finding[] = [];
  // The system's own class prefix (`Tenet-` for tenet-ui): elements carrying it are rendered by the package.
  const prefix = data.manifest.package.split(/[-/]/).pop()!.replace(/^./, (c) => c.toUpperCase());
  const prefixRe = new RegExp(`(^|\\s)${data.manifest.package.split(/[-/]/)[0]!.replace(/^./, (c) => c.toUpperCase())}-`);
  const isSystem = (el: SnapshotElement): boolean => Boolean(el.className && prefixRe.test(el.className));
  void prefix;
  const checks: Record<string, CheckStatus> = {};
  const stats: Record<string, number> = {};
  const g = (id: string): string => `ds://${data.version}/guidelines/${id}`;
  const elements = snap.computedStyles?.elements ?? [];

  // runtime: the stylesheet resolved, no console errors.
  if (wanted.has('runtime')) {
    const rc = snap.runtimeContract;
    if (!rc) checks.runtime = { status: 'skipped', detail: 'snapshot has no runtimeContract' };
    else {
      if (!rc.stylesheetLoaded) findings.push({ check: 'runtime', rule: 'contract/require-styles-import', severity: 'critical', message: `${data.manifest.package}/styles.css did not resolve on the page (missing ${(rc.missingTokens ?? []).join(', ') || 'tokens'})`, fix: { hint: `import '${data.manifest.package}/styles.css' once at the app root; every var(--token) is undefined until then`, resource: g('contract') }, id: 'runtime|require-styles-import' });
      if (rc.colorMode && rc.colorMode !== theme) findings.push({ check: 'runtime', rule: 'runtime/theme-mismatch', severity: 'warn', message: `page is in ${rc.colorMode} mode, judged as ${theme}`, fix: { hint: `pass theme: "${rc.colorMode}" or set data-color-mode="${theme}" on <html>` }, id: 'runtime|theme-mismatch' });
      const errors = [...new Set(snap.consoleErrors ?? [])];
      for (const e of errors.slice(0, 5)) findings.push({ check: 'runtime', rule: 'runtime/console-error', severity: 'warn', message: e.slice(0, 200), fix: { hint: 'fix runtime errors before judging visuals; a failed render skews every other check' }, id: fid(['runtime', 'console-error', e.slice(0, 60)]) });
      checks.runtime = { status: rc.stylesheetLoaded ? 'pass' : 'fail', detail: `stylesheet ${rc.stylesheetLoaded ? 'resolved' : 'NOT resolved'}, ${errors.length} console error(s)` };
    }
  }

  // tokens: every computed colour, font size, radius, padding and gap resolves to a token.
  if (wanted.has('tokens')) {
    if (!elements.length) checks.tokens = { status: 'skipped', detail: 'snapshot has no computedStyles' };
    else {
      const groups = new Map<string, { kind: 'color' | 'space' | 'fontSize' | 'radius'; prop: string; value: string; count: number; examples: string[] }>();
      const note = (kind: 'color' | 'space' | 'fontSize' | 'radius', prop: string, value: string, el: SnapshotElement): void => {
        const key = `${prop}=${value}`;
        const gr = groups.get(key) ?? { kind, prop, value, count: 0, examples: [] };
        gr.count++;
        if (gr.examples.length < 3) gr.examples.push(describe(el));
        groups.set(key, gr);
      };
      let families = 0;
      const badFamilies = new Map<string, number>();
      const tokenFamilies = data.tokens.filter((t) => t.path?.[0] === 'fontFamily').map((t) => firstFamily(String(t.value ?? '')));
      let system = 0;
      for (const el of elements) {
        if (/^(html|body|script|style|svg|path|circle|rect|line|g|polyline|polygon|use|defs)$/.test(el.tag)) continue;
        if (isSystem(el)) { system++; continue; }
        const s = el.styles;
        if (el.text && s.color) note('color', 'color', s.color, el);
        if (s['background-color'] && !TRANSPARENT.test(s['background-color'])) note('color', 'background-color', s['background-color'], el);
        if (s['border-top-color'] && s['border-top-width'] && s['border-top-width'] !== '0px' && s['border-top-style'] !== 'none' && !TRANSPARENT.test(s['border-top-color'])) note('color', 'border-color', s['border-top-color'], el);
        if (el.text && s['font-size']) note('fontSize', 'font-size', s['font-size'], el);
        const radius = s['border-radius'];
        if (radius && radius !== '0px' && /^\d+(\.\d+)?px$/.test(radius) && Number.parseFloat(radius) < 1000) note('radius', 'border-radius', radius, el);
        for (const p of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'row-gap', 'column-gap']) {
          const v = s[p];
          if (v && v !== '0px' && v !== 'normal' && /^\d+(\.\d+)?px$/.test(v)) note('space', p, v, el);
        }
        if (el.text && s['font-family']) {
          families++;
          const fam = firstFamily(s['font-family']);
          if (fam && tokenFamilies.length && !tokenFamilies.includes(fam)) badFamilies.set(fam, (badFamilies.get(fam) ?? 0) + 1);
        }
      }
      let gating = 0;
      const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
      stats.distinctValues = sorted.length;
      let offTokens = 0;
      for (const gr of sorted) {
        const r = resolveValue(data.tokens, gr.value, gr.kind, theme);
        if (r.exact || r.kind === 'unknown') continue;
        offTokens++;
        if (findings.filter((f) => f.check === 'tokens').length >= 40) break;
        const sev: Severity = gr.kind === 'color' ? (r.withinTolerance ? 'warn' : 'error') : 'error';
        if (sev === 'error') gating++;
        findings.push({ check: 'tokens', rule: gr.kind === 'color' ? 'tokens/no-token-color' : 'tokens/no-token-dimension', severity: sev, message: `${gr.prop}: ${gr.value} on ${gr.count} element(s) resolves to no ${theme} token (e.g. ${gr.examples.join('; ')})`, fix: { hint: r.token ? `nearest: var(${r.cssVar}) = ${r.tokenValue} (${gr.kind === 'color' ? 'ΔE' : 'Δ'} ${r.delta})${r.withinTolerance ? ', within tolerance — the value probably comes from the base palette or a hand-written override' : ' — an exception or a new token, not a silent snap'}` : `no ${gr.kind} tokens in ${data.version}`, token: r.token, guideline: g(gr.kind === 'color' ? 'color' : gr.kind === 'fontSize' ? 'typography' : 'layout') }, id: fid(['tokens', gr.kind, gr.prop, gr.value]) });
      }
      for (const [fam, n] of badFamilies) findings.push({ check: 'tokens', rule: 'tokens/no-token-font-family', severity: 'warn', message: `font-family "${fam}" on ${n} text element(s) is not a system family`, fix: { hint: `use var(${data.tokens.find((t) => t.path?.[0] === 'fontFamily' && t.path[1] === 'body')?.cssVar ?? '--fontFamily-body'}) or the display/mono family`, guideline: g('typography') }, id: fid(['tokens', 'font-family', fam]) });
      stats.elements = elements.length;
      stats.systemElements = system;
      stats.offTokenValues = offTokens;
      stats.textElements = families;
      checks.tokens = { status: gating ? 'fail' : 'pass', detail: `${sorted.length} distinct value(s) over ${elements.length - system} page element(s) (${system} inside system components, not judged); ${offTokens} off-token` };
    }
  }

  // contrast: text colour over its effective background, against WCAG and the documented pairs.
  if (wanted.has('contrast')) {
    if (!elements.length) checks.contrast = { status: 'skipped', detail: 'snapshot has no computedStyles' };
    else {
      const byPath = new Map(elements.map((e) => [e.path, e]));
      const parentOf = (e: SnapshotElement): SnapshotElement | undefined => {
        if (typeof e.parent === 'number') return elements[e.parent];
        const parent: string | undefined = e.path.includes(' > ') ? e.path.slice(0, e.path.lastIndexOf(' > ')) : undefined;
        return parent ? byPath.get(parent) : undefined;
      };
      const pageBg = data.tokens.find((t) => t.name === 'bgColor-default');
      const pageBgValue = (pageBg && (pageBg.themed ? pageBg[theme] : pageBg.value)) as string | undefined;
      const pairs = new Map<string, { fg: string; bg: string; ratio: number; large: boolean; count: number; examples: string[]; assumed: boolean }>();
      for (const el of elements) {
        if (!el.text || !el.styles.color) continue;
        const fg = parseRgba(el.styles.color);
        if (!fg || fg[3] === 0) continue;
        let bgEl: SnapshotElement | undefined = el;
        let bg: [number, number, number, number] | undefined;
        let assumed = false;
        while (bgEl) {
          const c = bgEl.styles['background-color'] ? parseRgba(bgEl.styles['background-color']) : undefined;
          if (c && c[3] > 0) { bg = c; break; }
          bgEl = parentOf(bgEl);
        }
        if (!bg) { const p = pageBgValue ? parseRgba(pageBgValue) : undefined; if (!p) continue; bg = p; assumed = true; }
        const bgRgb: [number, number, number] = [bg[0], bg[1], bg[2]];
        const fgRgb = composite(fg, bgRgb);
        const ratio = contrastRatio(fgRgb, bg[3] < 1 && pageBgValue ? composite(bg, parseRgba(pageBgValue)!.slice(0, 3) as [number, number, number]) : bgRgb);
        const size = Number.parseFloat(el.styles['font-size'] ?? '16');
        const weight = Number.parseInt(el.styles['font-weight'] ?? '400', 10);
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const key = `${el.styles.color}|${bgEl?.styles['background-color'] ?? 'page'}|${large ? 'L' : 'N'}`;
        const p = pairs.get(key) ?? { fg: el.styles.color, bg: bgEl?.styles['background-color'] ?? `page (${pageBgValue ?? '?'})`, ratio: Math.round(ratio * 100) / 100, large, count: 0, examples: [], assumed };
        p.count++;
        if (p.examples.length < 3) p.examples.push(`${describe(el)} “${el.text.slice(0, 30)}”`);
        pairs.set(key, p);
      }
      let gating = 0;
      let undocumented = 0;
      for (const p of pairs.values()) {
        const need = p.large ? 3 : 4.5;
        // Resolve against the role's own group first: #ffffff is bgColor-default as a background, fgColor-onEmphasis as text.
        const fgTok = preferGroup(data, p.fg, 'fgColor', theme);
        const bgTok = p.bg.startsWith('page') ? { exact: true, token: 'bgColor-default' } : preferGroup(data, p.bg, 'bgColor', theme);
        const fgRec = fgTok.exact && fgTok.token ? data.tokens.find((t) => t.name === fgTok.token) : undefined;
        const documented = fgRec?.contrast?.[theme];
        const aa = Array.isArray(documented) ? documented : documented?.aa ?? [];
        const aaLarge = Array.isArray(documented) ? [] : documented?.aaLarge ?? [];
        if (p.ratio < need) {
          gating++;
          findings.push({ check: 'contrast', rule: 'contrast/insufficient', severity: 'serious', message: `${p.fg} on ${p.bg}: ${p.ratio}:1, needs ${need}:1 (${p.large ? 'large' : 'normal'} text, ${p.count} element(s); e.g. ${p.examples.join('; ')})`, fix: { hint: fgRec && aa.length ? `${fgTok.token} is documented AA on: ${aa.join(', ')}${aaLarge.length ? `; large text also on ${aaLarge.join(', ')}` : ''}` : `pick a documented fg/bg pair: find_tokens("text colour") lists them${fgTok.token ? `; nearest fg token ${fgTok.token}` : ''}`, token: fgTok.token, guideline: g('color') }, id: fid(['contrast', 'insufficient', p.fg, p.bg, p.large ? 'L' : 'N']) });
        } else if (fgTok.exact && bgTok.exact && fgRec && documented && bgTok.token && !aa.includes(bgTok.token) && !(p.large && aaLarge.includes(bgTok.token))) {
          undocumented++;
          findings.push({ check: 'contrast', rule: 'contrast/undocumented-pair', severity: 'info', message: `${fgTok.token} on ${bgTok.token} passes at ${p.ratio}:1 but is not a documented pair (${p.count} element(s))`, fix: { hint: `documented for ${fgTok.token}: ${aa.join(', ')}`, guideline: g('color') }, id: fid(['contrast', 'undocumented', fgTok.token, bgTok.token]) });
        }
      }
      stats.textPairs = pairs.size;
      checks.contrast = { status: gating ? 'fail' : 'pass', detail: `${pairs.size} fg/bg pair(s), ${gating} below AA, ${undocumented} undocumented${[...pairs.values()].some((p) => p.assumed) ? '; page background assumed bgColor-default where none was painted' : ''}` };
    }
  }

  // a11y: axe, the accessibility tree, focus order against visual order.
  if (wanted.has('a11y')) {
    const parts: string[] = [];
    let gating = 0;
    const axeRules = new Set<string>();
    if (snap.axe) {
      const axe = axeFindings(data, [{ label: snap.title || snap.url || 'page', theme, violations: snap.axe.violations }]);
      findings.push(...axe.findings);
      gating += axe.gating;
      for (const v of snap.axe.violations) axeRules.add(v.id);
      parts.push(`axe: ${snap.axe.violations.length} violation(s)`);
    } else parts.push('axe: not run');
    if (snap.a11yTree) {
      const nodes = treeNodes(snap.a11yTree);
      let lastHeading = 0;
      let mains = 0;
      const counts: Record<string, number> = {};
      for (const n of nodes) {
        counts[n.role] = (counts[n.role] ?? 0) + 1;
        if (n.role === 'main') mains++;
        if (n.role === 'heading' && n.level) {
          if (lastHeading && n.level > lastHeading + 1) findings.push({ check: 'a11y', rule: 'a11y/heading-order', severity: 'warn', message: `heading level ${n.level} “${n.name ?? ''}” follows level ${lastHeading}`, fix: { hint: 'Heading levels must not skip; use `as` to decouple visual size from level', primitive: 'Heading', guideline: g('typography') }, id: fid(['a11y', 'heading-order', n.level, n.name?.slice(0, 30)]) });
          lastHeading = n.level;
        }
        const sev = NAME_ROLES[n.role];
        if (sev && !n.name) {
          const fix = ROLE_FIX[n.role];
          if (fix && axeRules.has(fix.axe)) continue; // axe already named the node precisely
          if (sev === 'critical' || sev === 'serious') gating++;
          findings.push({ check: 'a11y', rule: 'a11y/missing-name', severity: sev, message: `${n.role} #${counts[n.role]} in the accessibility tree has no accessible name${n.raw ? ` (${n.raw.slice(0, 60)})` : ''}`, fix: { hint: fix?.hint ?? 'give it an accessible name', primitive: fix?.primitive, guideline: g('accessibility') }, id: fid(['a11y', 'missing-name', n.role, counts[n.role]]) });
        }
      }
      if (nodes.length && mains !== 1 && !axeRules.has('landmark-one-main')) findings.push({ check: 'a11y', rule: 'a11y/landmark-one-main', severity: 'warn', message: mains ? `${mains} main landmarks` : 'no main landmark', fix: { hint: 'exactly one <main> per page; Stack is layout, not a landmark', guideline: g('layout') }, id: 'a11y|landmark-one-main' });
      parts.push(`tree: ${nodes.length} node(s)`);
      stats.treeNodes = nodes.length;
    } else parts.push('tree: absent');
    if (elements.length) {
      const interactive = elements.filter((e) => /^(button|a|input|select|textarea|summary)$/.test(e.tag) || /^(button|link|tab|menuitem|checkbox|switch|radio|combobox|textbox)$/.test(e.role ?? ''));
      const inversions: string[] = [];
      for (let i = 1; i < interactive.length; i++) {
        const a = interactive[i - 1]!;
        const b = interactive[i]!;
        const above = b.rect.y + b.rect.height <= a.rect.y;
        const sameRowBefore = Math.abs(b.rect.y - a.rect.y) < Math.min(a.rect.height, b.rect.height) / 2 && b.rect.x + b.rect.width <= a.rect.x;
        if (above || sameRowBefore) inversions.push(`${describe(b)} (${b.rect.x},${b.rect.y}) comes after ${describe(a)} (${a.rect.x},${a.rect.y}) in DOM order`);
      }
      if (inversions.length) findings.push({ check: 'a11y', rule: 'a11y/focus-order', severity: 'warn', message: `${inversions.length} focusable element(s) out of visual order: ${inversions.slice(0, 3).join('; ')}`, fix: { hint: 'focus order follows visual order: reorder the DOM (Stack/Grid) rather than positioning with CSS', primitive: 'Stack', guideline: g('accessibility') }, id: 'a11y|focus-order' });
      parts.push(`${interactive.length} focusable, ${inversions.length} out of order`);
      stats.focusable = interactive.length;
    }
    checks.a11y = snap.axe || snap.a11yTree || elements.length ? { status: gating ? 'fail' : 'pass', detail: parts.join('; ') } : { status: 'skipped', detail: 'snapshot has no axe, a11yTree or computedStyles' };
  }
  return { findings, checks, stats };
}

// ---- helpers -----------------------------------------------------------------------------------
function preferGroup(data: VersionData, value: string, group: string, theme: Theme): { exact: boolean; token?: string } {
  const own = resolveValue(data.tokens.filter((t) => t.path?.[0] === group), value, 'color', theme);
  if (own.exact) return own;
  const any = resolveValue(data.tokens, value, 'color', theme);
  return any.exact ? any : own.token ? own : any;
}
export const describe = (el: SnapshotElement): string => `${el.tag}${el.id ? `#${el.id}` : ''}${el.className ? `.${el.className.split(/\s+/)[0]}` : ''}${el.ariaLabel ? `[${el.ariaLabel.slice(0, 20)}]` : ''}`;
const firstFamily = (v: string): string => (v.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();

export function parseRgba(v: string): [number, number, number, number] | undefined {
  const m = v.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]); return [Number(m[1]), Number(m[2]), Number(m[3]), a]; }
  const rgb = parseColor(v);
  if (!rgb) return undefined;
  const hex8 = v.trim().match(/^#[0-9a-f]{8}$/i);
  return [rgb[0], rgb[1], rgb[2], hex8 ? Number.parseInt(v.trim().slice(7, 9), 16) / 255 : v.trim().toLowerCase() === 'transparent' ? 0 : 1];
}
const composite = (c: [number, number, number, number], over: [number, number, number]): [number, number, number] => [0, 1, 2].map((i) => Math.round(c[i]! * c[3] + over[i]! * (1 - c[3]))) as [number, number, number];
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

interface TreeNode { role: string; name?: string; level?: number; raw?: string }
/** Flatten Playwright's aria snapshot (YAML) or the legacy accessibility JSON into nodes in document order. */
export function treeNodes(tree: { format: string; tree: unknown }): TreeNode[] {
  const out: TreeNode[] = [];
  if (typeof tree.tree === 'string') {
    for (const line of tree.tree.split('\n')) {
      const m = line.match(/^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s*\[([^\]]*)\])?/);
      if (!m) continue;
      const attrs = m[3] ?? '';
      out.push({ role: m[1]!, name: m[2] ? m[2].replace(/\\"/g, '"') : undefined, level: attrs.match(/level=(\d+)/) ? Number(attrs.match(/level=(\d+)/)![1]) : undefined, raw: line.trim() });
    }
    return out;
  }
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { role?: string; name?: string; level?: number; children?: unknown[] };
    if (node.role) out.push({ role: node.role.toLowerCase(), name: node.name || undefined, level: node.level });
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree.tree);
  return out;
}
