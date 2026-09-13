// plan_tests (DESIGN.md §5): a deterministic test plan from a component's props, variants and the
// contract — one render test per variant, one interaction test per interactive prop, a11y
// assertions from the contract, keyboard paths, and the stories the visual check will use. Each
// case names the primitive it exercises and the rule it protects. The agent writes the tests.
import type { VersionData } from '../catalog/store.js';
import { parseSource, type ParsedSource } from '../checks/source.js';
import type { SourceFile } from '../checks/static.js';
import type { Plan } from './plan.js';

export type CaseKind = 'render' | 'interaction' | 'keyboard' | 'a11y' | 'contract' | 'visual';
export interface TestCase {
  id: string;
  kind: CaseKind;
  name: string;
  /** The system primitive the case exercises, when one. */
  primitive?: string;
  /** The contract line the case protects. */
  rule: string;
  steps: string[];
  assert: string;
  /** Story export the case renders, when the plan knows one. */
  story?: string;
}
export interface TestPlan {
  component: string;
  propsType?: string;
  file: string;
  runner: 'vitest' | 'jest';
  setup: { imports: string[]; notes: string[] };
  cases: TestCase[];
  stories: Array<{ exportName: string; storyId?: string; purpose: string }>;
  primitives: string[];
  source: 'files' | 'plan' | 'match';
  gaps: string[];
}

/** Keyboard and a11y behaviour the contract expects of each system primitive (tenet-ui 0.4). */
const PRIMITIVE_BEHAVIOUR: Record<string, Array<{ kind: 'keyboard' | 'a11y'; name: string; steps: string[]; assert: string; rule: string }>> = {
  IconButton: [{ kind: 'a11y', name: 'icon-only control has an accessible name', steps: ['render', 'getByRole("button", { name: /…/ })'], assert: 'the button is found by its aria-label', rule: 'every interactive element has an accessible name' }],
  Button: [{ kind: 'keyboard', name: 'button activates with Enter and Space', steps: ['render with onClick', 'tab to the button', 'press Enter, then Space'], assert: 'onClick called twice', rule: 'keyboard path and visible focus' }],
  Link: [{ kind: 'a11y', name: 'link text names the destination', steps: ['render', 'getByRole("link", { name })'], assert: 'an accessible name that is not "click here"', rule: 'every interactive element has an accessible name' }],
  Dialog: [
    { kind: 'keyboard', name: 'dialog traps focus and Escape closes it', steps: ['render open', 'expect focus inside the dialog', 'press Escape'], assert: 'onClose called and focus returns to the trigger', rule: 'keyboard path and visible focus' },
    { kind: 'a11y', name: 'dialog is labelled by its title', steps: ['render open', 'getByRole("dialog", { name })'], assert: 'role=dialog with aria-labelledby the title', rule: 'every interactive element has an accessible name' },
  ],
  Menu: [{ kind: 'keyboard', name: 'menu opens with Enter, arrows move, Escape closes and returns focus', steps: ['focus the trigger', 'press Enter', 'press ArrowDown twice', 'press Escape'], assert: 'the second item was focused; focus is back on the trigger', rule: 'keyboard path and visible focus' }],
  Select: [{ kind: 'keyboard', name: 'select opens with keyboard and announces its label', steps: ['render inside FormControl', 'tab to the combobox', 'press ArrowDown, Enter'], assert: 'onChange called with the highlighted option', rule: 'keyboard path and visible focus' }],
  Tabs: [{ kind: 'keyboard', name: 'arrow keys move between tabs', steps: ['render', 'focus the first tab', 'press ArrowRight'], assert: 'the second tab is selected and focused', rule: 'keyboard path and visible focus' }],
  Popover: [{ kind: 'keyboard', name: 'popover closes on Escape and returns focus', steps: ['open via trigger', 'press Escape'], assert: 'popover hidden, trigger focused', rule: 'keyboard path and visible focus' }],
  Tooltip: [{ kind: 'a11y', name: 'tooltip is exposed as the trigger description', steps: ['render', 'focus the trigger'], assert: 'trigger has aria-describedby pointing at the tooltip text', rule: 'every interactive element has an accessible name' }],
  TextInput: [{ kind: 'a11y', name: 'input is labelled', steps: ['render inside FormControl with FormControl.Label', 'getByLabelText'], assert: 'the input is found by its label', rule: 'every interactive element has an accessible name' }],
  Textarea: [{ kind: 'a11y', name: 'textarea is labelled', steps: ['render inside FormControl with FormControl.Label', 'getByLabelText'], assert: 'the textarea is found by its label', rule: 'every interactive element has an accessible name' }],
  NumberInput: [{ kind: 'keyboard', name: 'ArrowUp / ArrowDown step the value', steps: ['render with value', 'focus', 'press ArrowUp'], assert: 'onChange called with value + step', rule: 'keyboard path and visible focus' }],
  Checkbox: [{ kind: 'keyboard', name: 'Space toggles the checkbox', steps: ['render with label', 'tab, press Space'], assert: 'onChange called with checked=true', rule: 'keyboard path and visible focus' }],
  Switch: [{ kind: 'keyboard', name: 'Space toggles the switch', steps: ['render with label', 'tab, press Space'], assert: 'aria-checked flips', rule: 'keyboard path and visible focus' }],
  RadioGroup: [{ kind: 'keyboard', name: 'arrow keys move the selection', steps: ['render three options', 'focus the first', 'press ArrowDown'], assert: 'the second radio is checked', rule: 'keyboard path and visible focus' }],
  DataTable: [{ kind: 'a11y', name: 'table has a caption or aria-label and column headers', steps: ['render', 'getByRole("table", { name })', 'getAllByRole("columnheader")'], assert: 'name present; one header per column', rule: 'semantic elements first' }],
  Table: [{ kind: 'a11y', name: 'table has column headers', steps: ['render', 'getAllByRole("columnheader")'], assert: 'one header per column', rule: 'semantic elements first' }],
  Accordion: [{ kind: 'keyboard', name: 'Enter toggles a section and aria-expanded follows', steps: ['render', 'focus the first header', 'press Enter'], assert: 'aria-expanded toggles and the panel is visible', rule: 'keyboard path and visible focus' }],
  Toast: [{ kind: 'a11y', name: 'toast is announced', steps: ['trigger a toast'], assert: 'the message is inside a role=status / aria-live region', rule: 'semantic elements first' }],
  Avatar: [{ kind: 'a11y', name: 'avatar image has alt text', steps: ['render with src'], assert: 'getByRole("img", { name })', rule: 'missing alt is critical, never guessed' }],
  Heading: [{ kind: 'a11y', name: 'heading level matches the document outline', steps: ['render', 'getByRole("heading", { level })'], assert: 'the level is the one passed, not the visual size', rule: 'semantic elements first' }],
  Breadcrumbs: [{ kind: 'a11y', name: 'breadcrumbs are a labelled navigation with the current page marked', steps: ['render', 'getByRole("navigation", { name: /breadcrumb/i })'], assert: 'last item has aria-current="page"', rule: 'semantic elements first' }],
  Pagination: [{ kind: 'a11y', name: 'pagination is a labelled navigation with the current page marked', steps: ['render', 'getByRole("navigation")'], assert: 'aria-current on the current page', rule: 'semantic elements first' }],
  ProgressBar: [{ kind: 'a11y', name: 'progress bar exposes its value', steps: ['render value=40'], assert: 'role=progressbar with aria-valuenow=40 and an accessible name', rule: 'semantic elements first' }],
  DatePicker: [{ kind: 'keyboard', name: 'calendar opens with keyboard and arrows move days', steps: ['tab to the input', 'press ArrowDown', 'press ArrowRight'], assert: 'the next day is focused; Enter selects it', rule: 'keyboard path and visible focus' }],
  SegmentedControl: [{ kind: 'keyboard', name: 'arrow keys move between segments', steps: ['render', 'focus first', 'press ArrowRight'], assert: 'the second segment is selected', rule: 'keyboard path and visible focus' }],
};

export interface PlanTestsInput {
  files?: SourceFile[];
  plan?: Plan;
  matchComponents?: string[];
  name?: string;
  runner?: 'vitest' | 'jest';
}

export function buildTestPlan(data: VersionData, input: PlanTestsInput): TestPlan {
  const pkg = data.manifest.package;
  const runner = input.runner ?? 'vitest';
  const gaps: string[] = [];
  const cases: TestCase[] = [];
  const exportNames = new Map(data.components.flatMap((c) => [[c.exportName, c.name] as const, ...c.subcomponents.flatMap((s) => (s.exportName ? [[s.exportName, s.name] as const] : []))]));
  let component = input.name ?? 'Component';
  let propsType: string | undefined;
  let props: Array<{ name: string; kind: string; values?: string[]; optional: boolean }> = [];
  let primitives: string[] = [];
  let stories: TestPlan['stories'] = [];
  let source: TestPlan['source'] = 'files';
  let file = '';
  let usesImg = false;
  let hasChildren = false;

  if (input.files?.length) {
    const parsed = input.files.map((f) => parseSource(f, pkg));
    const main = parsed.find((p) => !p.isStories && !p.isTest && p.components.length) ?? parsed.find((p) => !p.isStories && !p.isTest);
    if (!main) gaps.push('no component file among the inputs; the plan is generic');
    const comp = main?.components.find((c) => c.exported) ?? main?.components[0];
    component = input.name ?? comp?.name ?? main?.path.split('/').pop()?.replace(/\.[jt]sx?$/, '') ?? component;
    const iface = main?.interfaces.find((i) => i.name === comp?.propsType) ?? main?.interfaces.find((i) => i.name === `${component}Props`) ?? main?.interfaces.find((i) => i.exported);
    propsType = iface?.name;
    props = iface?.props ?? [];
    primitives = [...new Set(parsed.flatMap((p) => p.packageImports).filter((n) => exportNames.has(n)))];
    usesImg = parsed.some((p) => (p.tags.img ?? 0) > 0);
    hasChildren = props.some((p) => p.name === 'children');
    const storiesFile = parsed.find((p) => p.isStories);
    if (storiesFile) stories = storiesFile.storyExports.filter((s) => s !== 'default').map((s) => ({ exportName: s, storyId: storyId(storiesFile.storyTitle, s), purpose: 'visual check + a11y render' }));
    else gaps.push(`no *.stories.tsx among the inputs: add a story per variant (${component}.stories.tsx) so the capture script can render and screenshot it`);
    if (!iface) gaps.push(`no props interface found for ${component}; export ${component}Props so prop-driven cases can be derived`);
    file = main ? main.path.replace(/\.([jt]sx?)$/, '.test.$1') : `${component}.test.tsx`;
    if (comp && !comp.forwardRef) gaps.push(`${component} does not forwardRef; the contract case "forwards its ref" will fail until it does`);
  } else if (input.plan) {
    source = 'plan';
    component = input.name ?? input.plan.name;
    primitives = [...new Set(input.plan.catalog.map((c) => c.component))].filter((n) => exportNames.has(n) || data.byId.has(n)).map((n) => exportNames.has(n) ? n : data.byId.get(n)?.exportName ?? n);
    props = [];
    for (const c of input.plan.catalog) for (const p of c.props) if (/^on[A-Z]/.test(p.name)) props.push({ name: p.name, kind: 'callback', optional: !p.required });
    file = input.plan.files.find((f) => /\.test\./.test(f.path))?.path ?? `${input.plan.files[0]?.path.replace(/\/[^/]+$/, '') ?? 'src'}/${component}.test.tsx`;
    stories = (input.plan.files.some((f) => /\.stories\./.test(f.path)) ? ['Default'] : []).map((s) => ({ exportName: s, purpose: 'visual check + a11y render' }));
    if (!stories.length) gaps.push('the plan has no stories file; add one story per variant');
    hasChildren = input.plan.tree.some((n) => n.children.length > 0);
  } else if (input.matchComponents) {
    source = 'match';
    primitives = [...new Set(input.matchComponents)].map((id) => data.byId.get(id)?.exportName ?? id);
    file = `src/${component}.test.tsx`;
    gaps.push('planned from a match only: run plan_component first for prop-level cases');
  }

  const rule = {
    render: 'renders with default props',
    variant: 'a story per variant',
    callback: 'interaction on an interactive prop',
    disabled: 'a disabled control is inert',
    a11y: 'no serious or critical axe violation',
    name: 'every interactive element has an accessible name',
    alt: 'missing alt is critical, never guessed',
    ref: 'forwardRef, spread rest, accept className',
    text: 'text content as props',
  };
  let n = 0;
  const add = (kind: CaseKind, name: string, r: string, steps: string[], assert: string, primitive?: string, story?: string): void => { cases.push({ id: `${kind}-${++n}`, kind, name, primitive, rule: r, steps, assert, story }); };

  // Render cases: default, then one per union value, then text props.
  add('render', 'renders with default props', rule.render, [`render(<${component} ${requiredProps(props)}/>)`], `no throw; the root element is in the document${hasChildren ? '; children render' : ''}`, undefined, stories[0]?.exportName);
  for (const p of props) {
    if (p.kind === 'union' && p.values) for (const v of p.values) add('render', `renders ${p.name}="${v}"`, rule.variant, [`render(<${component} ${p.name}="${v}" ${requiredProps(props)}/>)`], `the ${v} variant's class or attribute is present; snapshot-free`, undefined, stories.find((s) => s.exportName.toLowerCase() === v.replace(/[^a-z0-9]/gi, '').toLowerCase())?.exportName);
    if (p.kind === 'string' && p.name !== 'className' && p.name !== 'id') add('render', `renders the ${p.name} text`, rule.text, [`render(<${component} ${p.name}="…" ${requiredProps(props)}/>)`], `getByText("…") is in the document`);
  }
  // Interaction cases: one per callback; disabled is inert.
  const hasDisabled = props.some((p) => p.name === 'disabled');
  for (const p of props.filter((x) => x.kind === 'callback')) {
    const target = p.name.replace(/^on/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    add('interaction', `calls ${p.name} when the ${target} control is activated`, rule.callback, [`const ${p.name} = vi.fn()`, `render(<${component} ${p.name}={${p.name}} ${requiredProps(props)}/>)`, `await user.click(getByRole("button", { name: /${target}/i }))`], `${p.name} called once`);
    add('keyboard', `activates ${p.name} with the keyboard`, 'keyboard path and visible focus', ['tab to the control', 'press Enter'], `${p.name} called; the control has a visible focus ring (focus-visible class or outline)`);
    if (hasDisabled) add('interaction', `does not call ${p.name} when disabled`, rule.disabled, [`render(<${component} disabled ${p.name}={fn} …/>)`, 'click the control'], `${p.name} not called; aria-disabled or disabled attribute present`);
  }
  // a11y from the contract and from the primitives used.
  add('a11y', 'has no axe violations (default render)', rule.a11y, [`const { container } = render(<${component} ${requiredProps(props)}/>)`, `expect(await axe(container)).toHaveNoViolations()`], 'zero serious/critical violations');
  if (usesImg) add('a11y', 'image has alt text', rule.alt, ['render', 'getByRole("img", { name })'], 'alt is set (or alt="" for decorative and the image is not in the tree)');
  for (const prim of primitives) for (const b of PRIMITIVE_BEHAVIOUR[prim] ?? []) add(b.kind, b.name, b.rule, b.steps, b.assert, prim);
  // Contract.
  add('contract', 'forwards its ref and spreads rest props (className, data-*)', rule.ref, ['const ref = createRef<HTMLElement>()', `render(<${component} ref={ref} className="x" data-testid="t" …/>)`], 'ref.current is the root element; it has class x and data-testid');
  // Visual: the stories the capture script will screenshot.
  for (const s of stories) add('visual', `story ${s.exportName} renders and matches its baseline`, 'a story per variant', [`capture.mjs check ${file.replace(/\.test\./, '.')} ${file.replace(/\.test\.[jt]sx?$/, '.stories.tsx')}`], `axe clean in light and dark; screenshot compared by you against ${s.storyId ? `baseline ${s.storyId}` : 'the design'}`, undefined, s.exportName);

  const imports = [
    `import { render, screen } from '@testing-library/react';`,
    `import userEvent from '@testing-library/user-event';`,
    runner === 'vitest' ? `import { axe } from 'vitest-axe'; import 'vitest-axe/extend-expect';` : `import { axe, toHaveNoViolations } from 'jest-axe'; expect.extend(toHaveNoViolations);`,
    runner === 'vitest' ? `import { describe, expect, it, vi } from 'vitest';` : `// jest globals`,
    `import '${pkg}/styles.css'; // runtime contract: tokens and component CSS must resolve in jsdom too`,
  ];
  return { component, propsType, file, runner, setup: { imports, notes: [`environment: jsdom (${runner === 'vitest' ? 'test.environment' : 'testEnvironment'})`, 'name each test exactly as the case name: run_checks maps failures back to the case and the rule it protects'] }, cases, stories, primitives, source, gaps };
}

const requiredProps = (props: Array<{ name: string; kind: string; optional: boolean; values?: string[] }>): string =>
  props.filter((p) => !p.optional && p.name !== 'children').map((p) => `${p.name}=${p.kind === 'string' ? '"…"' : p.kind === 'number' ? '{1}' : p.kind === 'boolean' ? '' : p.kind === 'union' && p.values ? `"${p.values[0]}"` : '{…}'}`).join(' ');

// Storybook's toId(), as in the capture script.
const sanitize = (s: string): string => s.toLowerCase().replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
const storyId = (title: string | undefined, exportName: string): string | undefined => (title ? `${sanitize(title)}--${sanitize(exportName.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))}` : undefined);

export function testPlanMarkdown(plan: TestPlan): string {
  const lines = [`# Test plan: ${plan.component}`, '', `- File: \`${plan.file}\` · runner: ${plan.runner} · source: ${plan.source}`, `- Primitives: ${plan.primitives.join(', ') || 'none'}`, '', '## Setup', '', '```ts', ...plan.setup.imports, '```', ...plan.setup.notes.map((n) => `- ${n}`), '', '## Cases', ''];
  for (const c of plan.cases) lines.push(`- [${c.kind}] **${c.name}**${c.primitive ? ` (${c.primitive})` : ''} — protects: ${c.rule}`, `  - steps: ${c.steps.join(' → ')}`, `  - assert: ${c.assert}`);
  if (plan.gaps.length) lines.push('', '## Gaps', '', ...plan.gaps.map((g) => `- ${g}`));
  return lines.join('\n');
}

export function testSkeleton(plan: TestPlan): string {
  const byKind = (k: CaseKind): TestCase[] => plan.cases.filter((c) => c.kind === k);
  const block = (title: string, cs: TestCase[]): string[] => (cs.length ? [`  describe('${title}', () => {`, ...cs.map((c) => `    it.todo(${JSON.stringify(c.name)}); // ${c.rule}`), '  });'] : []);
  return [...plan.setup.imports, '', `describe('${plan.component}', () => {`, '  const user = userEvent.setup();', ...block('render', byKind('render')), ...block('interaction', [...byKind('interaction'), ...byKind('keyboard')]), ...block('accessibility', byKind('a11y')), ...block('contract', byKind('contract')), '});', ''].join('\n');
}

export type { ParsedSource };
