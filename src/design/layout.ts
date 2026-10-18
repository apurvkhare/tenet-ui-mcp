// The layout tree: what the agent's own model describes from the screenshot it sees (DESIGN.md §4
// ingest_design), or what the opt-in vision call produces. Region roles are free text in the
// catalog's vocabulary; the analyser also proposes catalog ids in `candidates`.
import { z } from 'zod';

export const ROLE_HINTS = [
  'page', 'header', 'nav', 'sidebar', 'section', 'container', 'card', 'form', 'field', 'input', 'textarea', 'select', 'checkbox', 'radio', 'switch',
  'button', 'icon-button', 'link', 'heading', 'text', 'label', 'caption', 'table', 'row', 'list', 'list-item', 'tabs', 'tab', 'breadcrumb', 'pagination',
  'badge', 'tag', 'avatar', 'icon', 'image', 'divider', 'banner', 'toast', 'dialog', 'menu', 'tooltip', 'progress', 'spinner', 'empty-state', 'footer', 'unknown',
] as const;

/** How to describe a screenshot as a layout tree. The vision call and ds://{v}/layout-schema share it. */
export const LAYOUT_RULES = [
  `Return regions from the outside in: the page, then its sections, then every control and text block. Give each region a stable id (r1, r2, …), a role from this list where one fits (${ROLE_HINTS.join(', ')}), a short label, the visible text strings, pixel bounds relative to the image, its parent id (null for roots), and the raw styles you can read off the pixels (hex colours, px sizes, weights). Fill every field; use null when a style is not visible.`,
  'In "candidates", propose up to three component ids from the design system that could implement the region, most likely first. Do not invent ids. For plain layout containers with no border or background, propose "stack" or "grid". For a bordered or raised container, propose "card".',
  'In "states", note things like primary, secondary, danger, disabled, selected, error, required, icon-only, sortable, selectable, loading.',
  'Be literal: report what is drawn, not what you think it should be.',
];

const bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const style = z.object({
  background: z.string().nullable(),
  color: z.string().nullable(),
  borderColor: z.string().nullable(),
  borderRadius: z.string().nullable(),
  fontSize: z.string().nullable(),
  fontWeight: z.string().nullable(),
  gap: z.string().nullable(),
  padding: z.string().nullable(),
});

/** Strict shape used as the vision output format: every field present, nullable where unknown. */
export const VisionLayoutSchema = z.object({
  viewport: z.object({ width: z.number(), height: z.number() }),
  theme: z.enum(['light', 'dark', 'unknown']),
  regions: z.array(z.object({
    id: z.string(),
    role: z.string(),
    label: z.string(),
    text: z.array(z.string()),
    bounds,
    parent: z.string().nullable(),
    candidates: z.array(z.string()),
    style,
    states: z.array(z.string()),
  })),
  palette: z.array(z.string()),
  notes: z.string(),
});
export type Layout = z.infer<typeof VisionLayoutSchema>;
export type Region = Layout['regions'][number];

/** Lenient shape the agent passes: defaults filled in, unknown style keys dropped. */
export const LayoutInputSchema = z.object({
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 1280, height: 800 }).describe('The image size as you see it; bounds use the same space'),
  theme: z.enum(['light', 'dark', 'unknown']).default('unknown'),
  regions: z.array(z.object({
    id: z.string().min(1).max(40),
    role: z.string().min(1).max(40).describe('page, section, card, button, input, heading, text, …'),
    label: z.string().max(200).optional(),
    text: z.array(z.string().max(500)).max(50).optional(),
    bounds: bounds.optional(),
    parent: z.string().nullable().optional(),
    candidates: z.array(z.string()).max(5).optional().describe('Catalog component ids, most likely first'),
    style: style.partial().optional().describe('Raw values you see: hex colours, px sizes'),
    states: z.array(z.string()).max(10).optional(),
  })).min(1).max(200).describe('Outside in; roles, rules and ids at ds://{v}/layout-schema'),
  palette: z.array(z.string()).max(32).optional(),
  notes: z.string().max(2000).optional(),
});
export type LayoutInput = z.infer<typeof LayoutInputSchema>;

export function normalizeLayout(input: LayoutInput): Layout {
  const ids = new Set(input.regions.map((r) => r.id));
  return {
    viewport: input.viewport,
    theme: input.theme,
    regions: input.regions.map((r) => ({
      id: r.id,
      role: r.role.toLowerCase(),
      label: r.label ?? '',
      text: r.text ?? [],
      bounds: r.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      parent: r.parent && ids.has(r.parent) ? r.parent : null,
      candidates: r.candidates ?? [],
      style: { background: null, color: null, borderColor: null, borderRadius: null, fontSize: null, fontWeight: null, gap: null, padding: null, ...(r.style ?? {}) },
      states: (r.states ?? []).map((s) => s.toLowerCase()),
    })),
    palette: input.palette ?? [],
    notes: input.notes ?? '',
  };
}

export function childrenOf(layout: Layout, id: string | null): Region[] {
  return layout.regions.filter((r) => r.parent === id);
}

export function summarizeLayout(layout: Layout): { regions: number; roots: number; roles: Record<string, number>; texts: number; palette: string[]; theme: string } {
  const roles: Record<string, number> = {};
  for (const r of layout.regions) roles[r.role] = (roles[r.role] ?? 0) + 1;
  return { regions: layout.regions.length, roots: childrenOf(layout, null).length, roles, texts: layout.regions.reduce((n, r) => n + r.text.length, 0), palette: layout.palette.slice(0, 12), theme: layout.theme };
}
