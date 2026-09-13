// Merge the server's own type extraction with the metadata the package ships by hand
// (`generated/components.json`: status, a11yReviewed, story ids, related, guidelines path,
// subcomponent grouping). Types are the truth for props; the shipped catalog is the truth for
// curation. Disagreements between the two are reported, never silently resolved.
import type { ExtractedComponent, ExtractedProp, ExtractedTypes } from './types.js';

export interface ShippedCatalog {
  schemaVersion: number;
  package: string;
  version: string;
  components: Record<string, ShippedComponent> | ShippedComponent[];
}
export interface ShippedComponent {
  id: string;
  name: string;
  status?: string;
  a11yReviewed?: boolean;
  importPath?: string;
  source?: string;
  guidelines?: string;
  extends?: string[];
  props?: Array<{ name: string; type?: string; required?: boolean; defaultValue?: string; description?: string; deprecated?: string; typeRef?: string }>;
  subcomponents?: Array<{ id?: string; name: string; kind?: string; props?: unknown[] }>;
  stories?: Array<{ id: string; name: string; exportName?: string }>;
  related?: string[];
  relatedTypes?: string[];
}

export type CatalogProp = ExtractedProp;

export interface CatalogSubcomponent {
  id: string;
  /** Display name: `FormControl.Label` for compound members, `Radio` / `useToast` for sibling exports. */
  name: string;
  kind: 'component' | 'hook' | 'function';
  /** Top-level export name when the part is imported on its own (`import { Radio }`), absent for compound members. */
  exportName?: string;
  propsType?: string;
  props: CatalogProp[];
  description: string;
}

export interface CatalogComponent {
  id: string;
  name: string;
  /** The export that implements it (`ToastProvider` for the `Toast` catalog entry). */
  exportName: string;
  kind: 'component' | 'hook' | 'function';
  status: string;
  a11yReviewed: boolean;
  importPath: string;
  description: string;
  propsType?: string;
  refType?: string;
  extends: string[];
  props: CatalogProp[];
  subcomponents: CatalogSubcomponent[];
  stories: Array<{ id: string; name: string; exportName?: string }>;
  related: string[];
  /** Path of the guideline page inside the guidelines revision (`guidelines/<id>.md`), when one exists. */
  guidelines?: string;
  /** Where each field came from. */
  provenance: { props: 'd.ts'; curation: 'package-catalog' | 'none' };
}

export interface CatalogMismatch {
  component: string;
  kind: 'prop-only-in-types' | 'prop-only-in-catalog' | 'component-only-in-types' | 'component-only-in-catalog' | 'deprecation-only-in-types' | 'deprecation-only-in-catalog';
  detail: string;
}

export interface MergedCatalog {
  components: CatalogComponent[];
  mismatches: CatalogMismatch[];
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export function mergeCatalog(extracted: ExtractedTypes, shipped: ShippedCatalog | undefined, importPath: string, guidelineExists: (id: string) => boolean): MergedCatalog {
  const shippedList: ShippedComponent[] = shipped ? (Array.isArray(shipped.components) ? shipped.components : Object.values(shipped.components)) : [];
  const exported = new Map(extracted.components.map((c) => [c.name, c]));
  const claimed = new Set<string>();
  const mismatches: CatalogMismatch[] = [];
  const components: CatalogComponent[] = [];

  const compoundSubs = (ex: ExtractedComponent, sh: ShippedComponent | undefined): CatalogSubcomponent[] =>
    ex.subcomponents.map((s) => {
      const shSub = sh?.subcomponents?.find((x) => x.name === s.name || x.name === s.name.split('.').pop());
      return { id: shSub?.id ?? kebab(s.name.replace('.', '')), name: s.name, kind: s.kind, propsType: s.propsType, props: s.props, description: s.description };
    });

  const build = (ex: ExtractedComponent, sh: ShippedComponent | undefined, id: string, subs: CatalogSubcomponent[]): CatalogComponent => ({
    id,
    name: sh?.name ?? ex.name,
    exportName: ex.name,
    kind: ex.kind,
    status: sh?.status ?? (ex.kind === 'component' ? 'unlisted' : 'stable'),
    a11yReviewed: sh?.a11yReviewed ?? false,
    importPath: sh?.importPath ?? importPath,
    description: ex.description,
    propsType: ex.propsType,
    refType: ex.refType,
    extends: ex.extends,
    props: ex.props,
    subcomponents: subs,
    stories: sh?.stories ?? [],
    related: sh?.related ?? [],
    guidelines: guidelineExists(id) ? `guidelines/${id}.md` : undefined,
    provenance: { props: 'd.ts', curation: sh ? 'package-catalog' : 'none' },
  });

  // 1. Every shipped entry, matched to the export that implements it.
  for (const sh of shippedList) {
    const subNames = (sh.subcomponents ?? []).map((s) => s.name);
    const primary = exported.get(sh.name) ?? subNames.map((n) => exported.get(n)).find((c) => c && c.kind === 'component');
    if (!primary) {
      mismatches.push({ component: sh.name, kind: 'component-only-in-catalog', detail: 'listed in generated/components.json but not exported from the .d.ts' });
      continue;
    }
    claimed.add(primary.name);
    const subs = compoundSubs(primary, sh);
    for (const s of sh.subcomponents ?? []) {
      if (s.name === primary.name || subs.some((x) => x.name === s.name || x.name.endsWith(`.${s.name}`))) continue;
      const ex = exported.get(s.name);
      if (!ex) continue; // e.g. a subcomponent documented under a compound name the types spell differently
      claimed.add(ex.name);
      subs.push({ id: s.id ?? kebab(ex.name), name: ex.name, kind: ex.kind, exportName: ex.name, propsType: ex.propsType, props: ex.props, description: ex.description });
    }
    // Props: types vs what the package documented.
    const own = primary.props.filter((p) => !p.inheritedFrom);
    const shippedNames = new Set((sh.props ?? []).map((p) => p.name));
    const typeNames = new Set(own.map((p) => p.name));
    for (const n of typeNames) if (!shippedNames.has(n)) mismatches.push({ component: sh.name, kind: 'prop-only-in-types', detail: n });
    for (const n of shippedNames) if (!typeNames.has(n)) mismatches.push({ component: sh.name, kind: 'prop-only-in-catalog', detail: n });
    for (const p of own) {
      const sp = (sh.props ?? []).find((x) => x.name === p.name);
      if (sp && Boolean(sp.deprecated) !== Boolean(p.deprecated)) mismatches.push({ component: sh.name, kind: p.deprecated ? 'deprecation-only-in-types' : 'deprecation-only-in-catalog', detail: p.name });
    }
    components.push(build(primary, sh, sh.id, subs));
  }

  // 2. Exports the package's catalog does not mention.
  for (const ex of extracted.components) {
    if (claimed.has(ex.name)) continue;
    if (ex.kind === 'component') mismatches.push({ component: ex.name, kind: 'component-only-in-types', detail: 'exported from the package but absent from generated/components.json' });
    components.push(build(ex, undefined, kebab(ex.name), compoundSubs(ex, undefined)));
  }

  components.sort((a, b) => a.id.localeCompare(b.id));
  return { components, mismatches };
}

export type { ExtractedComponent };
