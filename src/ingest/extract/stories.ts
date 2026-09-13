// Stories adapter: the built Storybook's `index.json` is the story index the server ingests
// (DESIGN.md §10). Ids are Storybook's own, so they match what the catalog references.
import { fetchJson, hashJson } from '../util.js';

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
  importPath?: string;
  tags: string[];
  hasPlay: boolean;
}
export interface StoriesIndex {
  storybookUrl: string;
  storybookVersion?: string;
  indexVersion?: number;
  contentHash: string;
  stories: StoryEntry[];
}

interface RawIndex {
  v?: number;
  entries: Record<string, { id: string; title: string; name: string; type: string; importPath?: string; tags?: string[] }>;
}

export async function fetchStories(storybookUrl: string): Promise<StoriesIndex | undefined> {
  const base = storybookUrl.endsWith('/') ? storybookUrl : `${storybookUrl}/`;
  const raw = await fetchJson<RawIndex>(`${base}index.json`, { optional: true });
  if (!raw?.entries) return undefined;
  const stories = Object.values(raw.entries)
    .filter((e) => e.type === 'story')
    .map((e) => ({ id: e.id, title: e.title, name: e.name, importPath: e.importPath, tags: e.tags ?? [], hasPlay: (e.tags ?? []).includes('play-fn') }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { storybookUrl: base, indexVersion: raw.v, contentHash: hashJson(stories), stories };
}
