import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogStore } from './store.js';

const store = new CatalogStore('snapshots');

test('resolve: exact, newest patch of minor, nearest earlier minor, latest of major, latest', () => {
  assert.deepEqual(store.versions(), ['0.3.0', '0.4.0']);
  assert.equal(store.resolve('latest').effective, '0.4.0');
  assert.equal(store.resolve(undefined).strategy, 'latest');
  assert.equal(store.resolve('0.3.0').strategy, 'exact');
  assert.equal(store.resolve('^0.4.0').effective, '0.4.0');
  const patch = store.resolve('0.3.7');
  assert.equal(patch.effective, '0.3.0');
  assert.equal(patch.strategy, 'newest-patch-of-minor');
  const earlier = store.resolve('0.3'); // "0.3" → same minor
  assert.equal(earlier.effective, '0.3.0');
  const none = store.resolve('0.2.0'); // nothing earlier than 0.2 → latest of major 0
  assert.equal(none.effective, '0.4.0');
  assert.equal(none.strategy, 'latest-of-major');
  const future = store.resolve('0.9.0'); // nearest earlier minor
  assert.equal(future.effective, '0.4.0');
  assert.equal(future.strategy, 'nearest-earlier-minor');
  const major = store.resolve('1.2.0');
  assert.equal(major.effective, '0.4.0');
  assert.equal(major.strategy, 'latest');
  assert.match(major.note ?? '', /no 1\.x snapshot/);
});

test('load: 0.4.0 has the full source set, 0.3.0 the gaps', () => {
  const v4 = store.load('0.4.0');
  assert.equal(v4.components.filter((c) => c.kind === 'component').length, 41);
  assert.ok(v4.tokens.length >= 100);
  assert.ok(v4.icons && v4.icons.icons.length === 80);
  assert.equal(v4.deprecations?.deprecations.length, 8);
  assert.equal(v4.stories?.stories.length, 153);
  assert.equal(v4.guidelines?.pages.length, 50);
  const v3 = store.load('0.3.0');
  assert.equal(v3.icons, undefined);
  assert.equal(v3.guidelines, undefined);
  assert.ok((v3.gaps?.summary['no-guideline'] ?? 0) > 30);
});

test('findComponent: id, export name, display name, sibling export', () => {
  const v4 = store.load('0.4.0');
  assert.equal(store.findComponent(v4, 'button')?.id, 'button');
  assert.equal(store.findComponent(v4, 'FormControl')?.id, 'form-control');
  assert.equal(store.findComponent(v4, 'formcontrol')?.id, 'form-control');
  assert.equal(store.findComponent(v4, 'ToastProvider')?.id, 'toast');
  assert.equal(store.findComponent(v4, 'Radio')?.id, 'radio-group');
  assert.equal(store.findComponent(v4, 'nope'), undefined);
});
