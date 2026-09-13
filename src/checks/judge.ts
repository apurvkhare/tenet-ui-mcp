// Judgment over what the agent ran (DESIGN.md §11, rev 3): the capture script's results.json →
// findings with fix hints in the system's vocabulary. A check the agent did not run is reported
// as skipped, never assumed green.
import { z } from 'zod';
import { resolveValue } from '../catalog/resolve.js';
import type { VersionData } from '../catalog/store.js';
import { similarity } from '../catalog/synonyms.js';
import type { Finding, Severity } from './static.js';

/** Lenient shape of the capture script's results.json (reference/capture.md). */
export const ResultsSchema = z.object({
  schemaVersion: z.number().optional(),
  tool: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  capturedAt: z.string().optional(),
  dsVersion: z.string().nullable().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  themes: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  render: z.object({ stories: z.string().nullable().optional(), title: z.string().nullable().optional(), component: z.string().nullable().optional(), runtimeContract: z.object({ stylesheetLoaded: z.boolean(), missingTokens: z.array(z.string()).optional(), colorMode: z.string().nullable().optional() }).nullable().optional(), errors: z.array(z.string()).optional() }).optional(),
  checks: z.object({
    types: z.object({ status: z.string(), reason: z.string().optional(), errors: z.array(z.object({ file: z.string().nullable().optional(), line: z.number().nullable().optional(), column: z.number().nullable().optional(), code: z.string().optional(), message: z.string() })).optional() }).optional(),
    lint: z.object({ status: z.string(), reason: z.string().optional(), config: z.string().optional(), findings: z.array(z.object({ file: z.string(), line: z.number().nullable().optional(), column: z.number().nullable().optional(), ruleId: z.string().nullable().optional(), severity: z.string(), message: z.string(), fixable: z.boolean().optional() })).optional() }).optional(),
    tests: z.object({ status: z.string(), reason: z.string().optional(), runner: z.string().optional(), total: z.number().optional(), passed: z.number().optional(), failed: z.number().optional(), cases: z.array(z.object({ file: z.string().optional(), name: z.string(), status: z.string(), message: z.string().optional() })).optional(), suiteErrors: z.array(z.object({ file: z.string(), message: z.string() })).optional() }).optional(),
    a11y: z.object({ status: z.string(), reason: z.string().optional(), renders: z.array(z.object({ story: z.string(), storyId: z.string().nullable().optional(), theme: z.string(), status: z.string(), error: z.string().optional(), violations: z.array(z.object({ id: z.string(), impact: z.string().optional(), help: z.string().optional(), helpUrl: z.string().optional(), nodes: z.array(z.object({ target: z.string(), html: z.string().optional(), summary: z.string().optional() })) })) })).optional() }).optional(),
    visual: z.object({ status: z.string(), reason: z.string().optional(), screenshots: z.array(z.object({ story: z.string(), storyId: z.string().nullable().optional(), theme: z.string(), status: z.string(), file: z.string().optional(), sha256: z.string().optional(), bytes: z.number().optional(), data: z.string().optional(), error: z.string().optional() })).optional() }).optional(),
  }),
});
export type CaptureResults = z.infer<typeof ResultsSchema>;

const fid = (parts: Array<string | number | undefined | null>): string => parts.filter((p) => p !== undefined && p !== null && p !== '').join('|');

const AXE_FIX: Record<string, { hint: string; primitive?: string; guideline: string }> = {
  'button-name': { hint: 'give the control an accessible name: text children, or aria-label on IconButton', primitive: 'IconButton', guideline: 'iconography' },
  'link-name': { hint: 'link text must describe the destination; use Link with visible text', primitive: 'Link', guideline: 'content' },
  'image-alt': { hint: 'alt is required; describe the image or alt="" if decorative — never guess', guideline: 'accessibility' },
  label: { hint: 'wrap the input in FormControl with FormControl.Label', primitive: 'FormControl', guideline: 'forms' },
  'color-contrast': { hint: 'pick a fg/bg pair from the documented contrast pairs (find_tokens shows them); the base palette is not for direct use', guideline: 'color' },
  'heading-order': { hint: 'Heading levels must not skip; use `as` to decouple visual size from level', primitive: 'Heading', guideline: 'typography' },
  'page-has-heading-one': { hint: 'one Heading level={1} per page', primitive: 'Heading', guideline: 'typography' },
  'aria-allowed-attr': { hint: 'remove the attribute or use the component that implements the role', guideline: 'accessibility' },
  'aria-required-children': { hint: 'use the compound parts of the component (e.g. Tabs.List / Tabs.Tab) so the roles nest correctly', guideline: 'accessibility' },
  'nested-interactive': { hint: 'do not nest a Button or Link inside another interactive element', guideline: 'accessibility' },
  region: { hint: 'wrap page content in landmarks (main, nav); Stack is layout, not a landmark', guideline: 'layout' },
  'landmark-one-main': { hint: 'exactly one <main> per page', guideline: 'layout' },
  'scrollable-region-focusable': { hint: 'a scrollable region needs tabIndex=0 or a focusable child', guideline: 'accessibility' },
  'duplicate-id': { hint: 'let FormControl generate ids; do not hardcode them', primitive: 'FormControl', guideline: 'forms' },
  list: { hint: 'use <ul>/<ol> with only <li> children; Stack is not a list', guideline: 'data-display' },
  'select-name': { hint: 'wrap Select in FormControl with a Label', primitive: 'FormControl', guideline: 'forms' },
  'empty-heading': { hint: 'a Heading must have text', primitive: 'Heading', guideline: 'typography' },
  'focus-order-semantics': { hint: 'use Button/Link instead of focusable divs', primitive: 'Button', guideline: 'accessibility' },
};
const IMPACT: Record<string, Severity> = { critical: 'critical', serious: 'serious', moderate: 'warn', minor: 'info' };

const LINT_GUIDELINE: Record<string, string> = { 'tenet-ui/no-raw-color': 'color', 'tenet-ui/no-raw-spacing': 'layout', 'tenet-ui/no-unknown-token': 'color', 'tenet-ui/prefer-component': 'contract', 'tenet-ui/require-styles-import': 'contract', 'tenet-ui/no-deprecated-api': 'contract' };

export interface Judged {
  findings: Finding[];
  /** Per check: what the agent ran and how it went. */
  checks: Record<string, { status: 'pass' | 'fail' | 'skipped' | 'error'; detail: string }>;
}

export function judgeResults(data: VersionData, results: CaptureResults, theme: 'light' | 'dark'): Judged {
  const findings: Finding[] = [];
  const checks: Judged['checks'] = {};
  const g = (id: string): string => `ds://${data.version}/guidelines/${id}`;
  const c = results.checks;

  // Version the agent captured against.
  if (results.dsVersion && results.dsVersion !== data.version) {
    findings.push({ check: 'types', rule: 'types/version-mismatch', severity: 'warn', message: `results were captured against ${results.dsVersion}, judged against ${data.version}`, fix: { hint: `pass dsVersion: "${results.dsVersion}" or upgrade the project`, resource: `ds://${data.version}/changelog` }, id: 'types|version-mismatch' });
  }
  // Runtime contract from the render.
  const rc = results.render?.runtimeContract;
  if (rc && !rc.stylesheetLoaded) {
    findings.push({ check: 'contract', rule: 'contract/require-styles-import', severity: 'critical', message: `the stylesheet did not resolve in the render (missing ${(rc.missingTokens ?? []).join(', ')})`, fix: { hint: `import '${data.manifest.package}/styles.css' once at the app root`, resource: `ds://${data.version}/guidelines/contract` }, id: 'contract|require-styles-import|render' });
  }
  for (const e of results.render?.errors ?? []) findings.push({ check: 'a11y', rule: 'render/error', severity: 'error', message: e, fix: { hint: 'the story did not render; fix the runtime error before judging a11y or visuals' }, id: fid(['render', 'error', e.slice(0, 60)]) });

  // types
  if (!c.types || c.types.status === 'skipped') checks.types = { status: 'skipped', detail: c.types?.reason ?? 'not run' };
  else if (c.types.status === 'error') checks.types = { status: 'error', detail: c.types.reason ?? 'tsc failed to run' };
  else {
    for (const e of c.types.errors ?? []) findings.push(typeFinding(data, e));
    checks.types = { status: (c.types.errors?.length ?? 0) ? 'fail' : 'pass', detail: `${c.types.errors?.length ?? 0} error(s)` };
  }
  // lint
  if (!c.lint || c.lint.status === 'skipped') checks.lint = { status: 'skipped', detail: c.lint?.reason ?? 'not run' };
  else if (c.lint.status === 'error') checks.lint = { status: 'error', detail: c.lint.reason ?? 'eslint failed to run' };
  else {
    let gating = 0;
    for (const f of c.lint.findings ?? []) {
      const rule = f.ruleId ?? 'parse-error';
      const sev: Severity = f.severity === 'warn' ? 'warn' : 'error';
      if (sev === 'error') gating++;
      const value = f.message.match(/(#[0-9a-f]{3,8}|rgba?\([^)]*\)|\b\d+(?:\.\d+)?(?:px|rem)\b)/i)?.[1];
      const r = value ? resolveValue(data.tokens, value, /px|rem/.test(value) ? 'space' : 'color', theme) : undefined;
      findings.push({ check: 'lint', rule, severity: sev, file: f.file, line: f.line ?? undefined, column: f.column ?? undefined, message: f.message, fix: { hint: r?.token ? `nearest token: var(${r.cssVar}) (${r.tokenValue}${r.delta ? `, Δ${r.delta}` : ''})` : f.fixable ? 'eslint --fix applies the rename' : 'see the rule\'s guideline', token: r?.token, guideline: LINT_GUIDELINE[rule] ? g(LINT_GUIDELINE[rule]!) : undefined }, id: fid(['lint', rule, f.file, f.line, value]) });
    }
    checks.lint = { status: gating ? 'fail' : 'pass', detail: `${c.lint.findings?.length ?? 0} finding(s), ${gating} error-level (${c.lint.config ?? 'config unknown'})` };
  }
  // tests
  if (!c.tests || c.tests.status === 'skipped') checks.tests = { status: 'skipped', detail: c.tests?.reason ?? 'not run' };
  else if (c.tests.status === 'error') checks.tests = { status: 'error', detail: c.tests.reason ?? 'runner failed' };
  else {
    const failed = (c.tests.cases ?? []).filter((t) => t.status === 'failed');
    for (const t of failed) findings.push({ check: 'tests', rule: 'tests/failed', severity: 'error', file: t.file, message: `${t.name}: ${(t.message ?? '').split('\n')[0]}`, fix: { hint: `protects: ${protectedRule(t.name)}` }, id: fid(['tests', 'failed', t.file, t.name]) });
    for (const s of c.tests.suiteErrors ?? []) findings.push({ check: 'tests', rule: 'tests/suite-error', severity: 'error', file: s.file, message: s.message.split('\n')[0]!, fix: { hint: 'the suite did not load; fix imports or environment (jsdom) first' }, id: fid(['tests', 'suite-error', s.file]) });
    checks.tests = { status: failed.length || (c.tests.suiteErrors?.length ?? 0) ? 'fail' : 'pass', detail: `${c.tests.passed ?? 0}/${c.tests.total ?? 0} passed (${c.tests.runner ?? 'runner'})` };
  }
  // a11y
  if (!c.a11y || c.a11y.status === 'skipped') checks.a11y = { status: 'skipped', detail: c.a11y?.reason ?? 'not run' };
  else if (c.a11y.status === 'error' && !(c.a11y.renders?.length)) checks.a11y = { status: 'error', detail: c.a11y.reason ?? 'render failed' };
  else {
    const renders = c.a11y.renders ?? [];
    for (const r of renders) if (r.status === 'error') findings.push({ check: 'a11y', rule: 'render/error', severity: 'error', message: `${r.story} [${r.theme}]: ${r.error ?? 'did not render'}`, fix: { hint: 'fix the render error first' }, id: fid(['a11y', 'render-error', r.story, r.theme]) });
    const axe = axeFindings(data, renders.filter((r) => r.status !== 'error').map((r) => ({ label: r.story, theme: r.theme, violations: r.violations })));
    findings.push(...axe.findings);
    checks.a11y = { status: axe.gating ? 'fail' : renders.some((r) => r.status === 'error') ? 'error' : 'pass', detail: `${renders.length} render(s), ${axe.gating} serious/critical` };
  }
  return { findings, checks };
}

export interface AxeRender { label: string; theme: string; violations: Array<{ id: string; impact?: string; help?: string; helpUrl?: string; nodes: Array<{ target: string; html?: string; summary?: string }> }> }

/** axe violations → findings in the contract's vocabulary; one finding per node across themes. Shared by run_checks and audit_page. */
export function axeFindings(data: VersionData, renders: AxeRender[]): { findings: Finding[]; gating: number } {
  const findings: Finding[] = [];
  const g = (id: string): string => `ds://${data.version}/guidelines/${id}`;
  const seen = new Set<string>();
  let gating = 0;
  for (const r of renders) {
    for (const v of r.violations) {
      const sev = IMPACT[v.impact ?? ''] ?? 'warn';
      const fix = AXE_FIX[v.id] ?? { hint: v.help ?? v.id, guideline: 'accessibility' };
      for (const n of v.nodes) {
        const key = fid(['a11y', v.id, n.target]);
        if (seen.has(key)) continue;
        seen.add(key);
        if (sev === 'critical' || sev === 'serious') gating++;
        const themes = renders.filter((x) => x.violations.some((y) => y.id === v.id && y.nodes.some((z) => z.target === n.target))).map((x) => x.theme);
        findings.push({ check: 'a11y', rule: `axe/${v.id}`, severity: sev, message: `${v.id} on ${n.target} (${r.label}${themes.length > 1 ? ', both themes' : `, ${r.theme}`}): ${n.summary || v.help || ''}`.trim(), fix: { hint: fix.hint, primitive: fix.primitive, guideline: g(fix.guideline), resource: v.helpUrl }, id: key });
      }
    }
  }
  return { findings, gating };
}

function typeFinding(data: VersionData, e: { file?: string | null; line?: number | null; column?: number | null; code?: string; message: string }): Finding {
  const base = { check: 'types', rule: `types/${e.code ?? 'TS'}`, severity: 'error' as const, file: e.file ?? undefined, line: e.line ?? undefined, column: e.column ?? undefined, message: e.message, id: fid(['types', e.code, e.file, e.line, e.message.slice(0, 40)]) };
  // Property 'x' does not exist on type 'ButtonProps' | Object literal may only specify known properties, and 'x' does not exist in type 'ButtonProps'
  const m = e.message.match(/'([A-Za-z0-9_$-]+)' does not exist (?:on|in) type '(?:[^']*?)?([A-Z][A-Za-z0-9]*Props)\b/);
  if (m) {
    const comp = data.components.find((c) => c.propsType === m[2]) ?? data.components.find((c) => c.subcomponents.some((s) => s.propsType === m[2]));
    if (comp) {
      const props = comp.props.map((p) => p.name);
      const nearest = props.map((p) => ({ p, s: similarity(m[1]!, p) })).sort((a, b) => b.s - a.s)[0];
      const dep = data.deprecations?.deprecations.find((d) => d.component === comp.name && d.prop === m[1]);
      return { ...base, fix: { hint: dep ? `${m[1]} was ${dep.message}` : nearest && nearest.s > 0.3 ? `${comp.name} has no prop ${m[1]}; did you mean ${nearest.p}?` : `${comp.name} props: ${props.slice(0, 10).join(', ')}`, primitive: comp.name, replacement: dep?.replacement ?? nearest?.p, resource: `ds://${data.version}/components/${comp.id}` } };
    }
  }
  // Type '"x"' is not assignable to type 'ButtonVariant'
  const u = e.message.match(/Type '"([^"]*)"' is not assignable to type '([A-Z][A-Za-z0-9]*)'/);
  if (u) {
    for (const c of data.components) {
      const p = c.props.find((x) => x.typeRef === u[2]);
      if (p) return { ...base, fix: { hint: `${c.name}.${p.name} accepts ${p.type}`, primitive: c.name, resource: `ds://${data.version}/components/${c.id}` } };
    }
  }
  const mod = e.message.match(/Cannot find module '([^']+)'/);
  if (mod && mod[1]!.startsWith(data.manifest.package)) return { ...base, fix: { hint: `${data.manifest.package} ${data.version} exports: ${data.manifest.sources.find((s) => s.kind === 'types') ? '., ./icons, ./styles.css, ./tokens.css, ./tokens.json' : 'see package.json'}`, resource: `ds://${data.version}/gaps` } };
  return { ...base, fix: { hint: 'fix the type error; the documented props are in get_component' } };
}

export function protectedRule(name: string): string {
  const n = name.toLowerCase();
  if (/no axe violations|axe/.test(n)) return 'accessibility: no serious or critical axe violation';
  if (/accessible name|labell?ed|has alt/.test(n)) return 'accessibility: every interactive element has an accessible name';
  if (/forwards? (its )?ref|classname|rest props/.test(n)) return 'contract: forwardRef, spread rest, accept className';
  if (/does not call|disabled/.test(n)) return 'a disabled control is inert';
  if (/^renders variant|^renders size|^renders /.test(n)) return 'a story per variant renders';
  if (/axe|a11y|accessib|aria|label|name/.test(n)) return 'accessibility: every interactive element has an accessible name';
  if (/keyboard|focus|escape|enter|space|arrow/.test(n)) return 'keyboard path and visible focus';
  if (/render|default/.test(n)) return 'renders with default props';
  if (/click|change|toggle|select|open|close/.test(n)) return 'interaction on an interactive prop';
  return 'the plan_tests case with this name';
}
