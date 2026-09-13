// Prompts (DESIGN.md §6): one per path. Short, procedural, with the anti-duplicate-call rule and
// the stop condition. The skill teaches judgment; these just name the sequence.
import { z } from 'zod';
import type { CatalogStore } from './catalog/store.js';

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  args: z.ZodRawShape;
  render: (args: Record<string, string | undefined>, store: CatalogStore) => string;
}

const version = (args: Record<string, string | undefined>, store: CatalogStore): string => args.dsVersion || store.latest();
const common = (v: string): string => `Rules: pass dsVersion "${v}" (the consumer's lockfile version) on every call; never call the same tool twice with the same arguments — read the resource it linked instead; read ds://${v}/guidelines/contract once before writing; fix findings by severity (critical, serious, error, then warn); stop when run_checks passes with no critical or serious finding, or after three rounds — then report what remains and why.`;

export const PROMPTS: PromptDef[] = [
  {
    name: 'design-to-code',
    title: 'Design to code',
    description: 'Turn a design (screenshot or layout) into a component that complies with the design system, then prove it with run_checks.',
    args: { dsVersion: z.string().optional().describe('Lockfile version of the design system in this project'), name: z.string().optional().describe('Component name'), design: z.string().optional().describe('Path or description of the design') },
    render: (a, store) => { const v = version(a, store); return [`Build ${a.name ? `the ${a.name} component` : 'a component'} from ${a.design ?? 'the design I give you'} with the design system at ${v}.`, 'Path: 1) ingest_design (image or layout) → designId. 2) match_components (answer its questions, or strategy auto) → matchId. 3) resolve_tokens → every colour, space, radius and font is a token or a recorded exception. 4) plan_component → the plan; read its catalog excerpts. 5) Write the files the plan names: component, props interface, a story per variant, tests from plan_tests. 6) Run the skill\'s capture script (check mode, --embed-screenshots) and call run_checks with the files, results.json and designId. 7) Compare the screenshot against the design yourself; SSIM is advisory.', common(v)].join('\n'); },
  },
  {
    name: 'audit-ui',
    title: 'Audit existing UI',
    description: 'Audit existing code and a running page against the design system, fix by severity, prove the delta.',
    args: { dsVersion: z.string().optional().describe('Lockfile version'), url: z.string().optional().describe('URL of the running page'), files: z.string().optional().describe('Files or globs to audit') },
    render: (a, store) => { const v = version(a, store); return [`Audit ${a.files ?? 'the UI files I point you at'}${a.url ? ` and the page at ${a.url}` : ''} against the design system at ${v}.`, 'Path: 1) audit_code with the source files → auditId; note the byRule summary. 2) Run the capture script in page mode on the running page (--embed-screenshots if a designId exists) and call audit_page with snapshot.json → second auditId. 3) Fix by severity: deprecations and raw values first (the fix hints name the token, prop or primitive), then contract, then a11y. 4) Re-run audit_code / audit_page with auditId to show fixed / new / remaining. 5) Finish with the capture script in check mode and run_checks so types, lint, tests and axe are judged too.', common(v)].join('\n'); },
  },
  {
    name: 'test-ui',
    title: 'Test a component',
    description: 'Plan, write and run the tests a component needs under the contract.',
    args: { dsVersion: z.string().optional().describe('Lockfile version'), component: z.string().optional().describe('Component file') },
    render: (a, store) => { const v = version(a, store); return [`Write the tests for ${a.component ?? 'the component I name'} against the design system at ${v}.`, 'Path: 1) plan_tests with the component, its props and its stories file → cases with the primitive each exercises and the rule it protects. 2) Write the test file from the skeleton; name each test exactly as its case. 3) Run the capture script in check mode (it runs the project\'s vitest/jest) and call run_checks with results.json; failed cases map back to the plan. 4) Fix, re-run with auditId, at most three rounds.', common(v)].join('\n'); },
  },
];
