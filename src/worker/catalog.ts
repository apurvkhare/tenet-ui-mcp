// The catalog on Workers: snapshot text files bundled into the Worker (scripts/bundle-snapshots.mjs),
// baseline PNGs from the ASSETS binding. One store per isolate; a new snapshot means a new deploy.
import { content, texts } from '../../.worker/snapshots.generated.js';
import { memoryFiles, setContentSource } from '../catalog/files.js';
import { CatalogStore } from '../catalog/store.js';
import type { Env } from './auth-ui.js';

setContentSource((name) => content[name]);

let store: CatalogStore | undefined;

export function getStore(env: Env): CatalogStore {
  store ??= new CatalogStore(
    memoryFiles(texts, async (path) => {
      const res = await env.ASSETS.fetch(new Request(`https://assets.local/${path}`));
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
    }),
  );
  return store;
}
