// Component ranking shared by search_components and match_components: names, synonyms,
// descriptions and the "when to use" line of the guidelines.
import type { CatalogComponent } from '../ingest/extract/catalog.js';
import type { VersionData } from './store.js';
import { COMPONENT_SYNONYMS, similarity, tokenize } from './synonyms.js';

export interface RankedComponent {
  component: CatalogComponent;
  score: number;
  matchedOn: string[];
}

export function whenToUse(data: VersionData, c: CatalogComponent): string | undefined {
  const page = data.guidelines?.pages.find((p) => p.scope === 'component' && p.id === c.id);
  const pre = page?.sections.find((s) => s.level <= 1)?.body ?? page?.sections[0]?.body;
  return pre?.replace(/\*\*When to use:\*\*\s*/i, '').split('\n')[0];
}

export function rankComponents(data: VersionData, query: string, limit = 5): RankedComponent[] {
  const words = tokenize(query);
  const q = query.toLowerCase().trim();
  return data.components
    .filter((c) => c.kind === 'component')
    .map((c) => {
      let score = 0;
      const on = new Set<string>();
      const idWords = c.id.split('-');
      const nameLower = c.name.toLowerCase();
      if (c.id === q.replace(/\s+/g, '-') || nameLower === q) { score += 1; on.add('name'); }
      else if (nameLower.startsWith(q) || c.id.startsWith(q)) { score += 0.8; on.add('name'); }
      else if (q.length > 2 && (nameLower.includes(q) || c.id.includes(q))) { score += 0.6; on.add('name'); }
      for (const w of words) {
        if (idWords.includes(w)) { score += 0.5; on.add('name'); }
        const syns = COMPONENT_SYNONYMS[w] ?? [];
        const i = syns.indexOf(c.id);
        if (i >= 0) { score += 0.7 - 0.1 * i; on.add(`synonym:${w}`); }
      }
      const qs = COMPONENT_SYNONYMS[q] ?? [];
      const qi = qs.indexOf(c.id);
      if (qi >= 0) { score += 0.9 - 0.15 * qi; on.add(`synonym:${q}`); }
      const desc = c.description.toLowerCase();
      const wtu = whenToUse(data, c)?.toLowerCase() ?? '';
      for (const w of words) {
        if (desc.includes(w)) { score += 0.25; on.add('description'); }
        if (wtu.includes(w)) { score += 0.2; on.add('guidelines'); }
      }
      if (c.status === 'deprecated') score *= 0.6;
      return { component: c, score: Math.round(score * 100) / 100, matchedOn: [...on] };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.component.id.localeCompare(b.component.id))
    .slice(0, limit);
}

export function nearestNames(data: VersionData, query: string, n = 5): string[] {
  return data.components
    .filter((c) => c.kind === 'component')
    .map((c) => ({ id: c.id, s: similarity(query, c.id) + similarity(query, c.name) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.id);
}
