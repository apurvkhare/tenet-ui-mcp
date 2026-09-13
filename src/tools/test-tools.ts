// plan_tests (DESIGN.md §5): a deterministic test plan from a component's files or from a
// design's plan. The agent writes the tests; run_checks maps failures back to these cases.
import { z } from 'zod';
import { buildTestPlan, testPlanMarkdown, testSkeleton, type TestPlan } from '../design/test-plan.js';
import type { Row } from '../store/design-store.js';
import { capJson } from './caps.js';
import type { ToolDef } from './catalog-tools.js';
import { pickVersion, ToolError, versionMeta } from './context.js';
import type { DesignRow, MatchRow, PlanRow } from './design-tools.js';

const dsVersionArg = z.string().default('latest').describe('Lockfile version, "0.4", or "latest".').meta({ 'x-mcp-header': 'DsVersion' });
const dsMeta = { dsVersion: z.string(), dsVersionNote: z.string().optional(), guidelinesRevision: z.string().optional() };
const shape = (fields: string): z.ZodUnknown => z.unknown().describe(fields);

export const planTests: ToolDef<{ files: z.ZodOptional<z.ZodArray<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>>>; matchId: z.ZodOptional<z.ZodString>; name: z.ZodOptional<z.ZodString>; runner: z.ZodDefault<z.ZodEnum<{ vitest: 'vitest'; jest: 'jest' }>>; dsVersion: typeof dsVersionArg; skeleton: z.ZodDefault<z.ZodBoolean>; markdown: z.ZodDefault<z.ZodBoolean> }> = {
  name: 'plan_tests',
  title: 'Plan tests',
  description: 'A test plan from a component\'s files (or a matchId): a render test per variant, interaction + keyboard tests per callback prop, a11y assertions from the contract and the primitives used, the stories the visual check uses. Each case names the primitive and the rule it protects.',
  scope: 'ds:read',
  cap: 12288,
  inputSchema: {
    files: z.array(z.object({ path: z.string().min(1).max(300), content: z.string().max(256 * 1024) })).max(16).optional().describe('The component, its props and its stories file.'),
    matchId: z.string().optional().describe('Plan from a design match instead (uses the latest plan_component plan for it).'),
    name: z.string().max(80).optional().describe('Component name when it cannot be read from the files.'),
    runner: z.enum(['vitest', 'jest']).default('vitest'),
    dsVersion: dsVersionArg,
    skeleton: z.boolean().default(true).describe('Include a test-file skeleton with one it.todo per case.'),
    markdown: z.boolean().default(false).describe('Also include the plan as markdown.'),
  },
  outputSchema: {
    component: z.string(),
    file: z.string(),
    runner: z.string(),
    setup: shape('{imports[], notes[]}'),
    cases: z.array(shape('{id, kind: render|interaction|keyboard|a11y|contract|visual, name, primitive?, rule, steps[], assert, story?}')),
    stories: z.array(shape('{exportName, storyId?, purpose}')),
    primitives: z.array(z.string()),
    gaps: z.array(z.string()),
    skeleton: z.string().optional(),
    markdown: z.string().optional(),
    ...dsMeta,
  },
  run(args, ctx) {
    if (!args.files?.length && !args.matchId) throw new ToolError('pass files[] (component + stories) or a matchId', 'invalid_arguments');
    let plan: TestPlan;
    let v = pickVersion(ctx, args.dsVersion);
    if (args.matchId) {
      if (!ctx.designs || !ctx.principal) throw new ToolError('design handles are not available on this transport', 'unavailable');
      const match = ctx.designs.get<MatchRow>('match', ctx.principal.sub, args.matchId);
      if (!match) throw new ToolError(`match ${args.matchId} not found (unknown, expired, or not yours)`, 'not_found');
      v = pickVersion(ctx, match.data.dsVersion);
      const design = ctx.designs.get<DesignRow>('design', ctx.principal.sub, match.data.designId);
      const planRow = design?.data.plans.map((id) => ctx.designs!.get<PlanRow>('plan', ctx.principal!.sub, id)).filter((p): p is Row<PlanRow> => Boolean(p)).reverse().find((p) => p.data.matchId === match.id);
      plan = buildTestPlan(v.data, planRow ? { plan: planRow.data.plan, name: args.name, runner: args.runner } : { matchComponents: match.data.assignments.map((a) => a.component).filter((c): c is string => Boolean(c)), name: args.name ?? design?.data.name, runner: args.runner });
    } else {
      plan = buildTestPlan(v.data, { files: args.files, name: args.name, runner: args.runner });
    }
    const meta = versionMeta(v);
    const structured: Record<string, unknown> = { ...plan, skeleton: args.skeleton ? testSkeleton(plan) : undefined, markdown: args.markdown ? testPlanMarkdown(plan) : undefined, ...meta };
    const kinds = plan.cases.reduce<Record<string, number>>((acc, c) => { acc[c.kind] = (acc[c.kind] ?? 0) + 1; return acc; }, {});
    return {
      structured: capJson(structured, this.cap, 'set skeleton: false or markdown: false').value,
      text: `${plan.cases.length} case(s) for ${plan.component} → ${plan.file} (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}); primitives: ${plan.primitives.join(', ') || 'none'}.${plan.gaps.length ? ` Gaps: ${plan.gaps[0]}` : ''} Name each test exactly as its case so run_checks can map failures back.`,
      links: [{ uri: `ds://${v.resolved.effective}/guidelines/contract`, name: 'component contract', mimeType: 'text/markdown' }, ...plan.primitives.slice(0, 4).map((p) => ({ uri: `ds://${v.resolved.effective}/components/${p.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`, name: p, mimeType: 'text/markdown' }))],
    };
  },
};

export const TEST_TOOLS: ToolDef<z.ZodRawShape>[] = [planTests] as unknown as ToolDef<z.ZodRawShape>[];
