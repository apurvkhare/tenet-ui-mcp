import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSemver } from './snapshot.js';
import { hashJson, parseFrontmatter, splitSections } from './util.js';

test('parseFrontmatter reads scalars and bracket lists', () => {
  const { data, content } = parseFrontmatter('---\ncomponent: button\nrelated: [icon-button, link]\nupdated: 2026-09-12\n---\n# Button\n\nBody');
  assert.deepEqual(data, { component: 'button', related: ['icon-button', 'link'], updated: '2026-09-12' });
  assert.equal(content, '# Button\n\nBody');
});

test('splitSections keeps headings and ignores # inside code fences', () => {
  const s = splitSections('intro\n\n## Rules\n- one\n```\n# not a heading\n```\n## Do / Don\'t\n- two');
  assert.deepEqual(s.map((x) => [x.level, x.heading]), [[0, ''], [2, 'Rules'], [2, "Do / Don't"]]);
  assert.match(s[1]!.body, /# not a heading/);
});

test('hashJson is key-order independent', () => {
  assert.equal(hashJson({ a: 1, b: [1, { c: 2, d: 3 }] }), hashJson({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
});

test('compareSemver orders numerically and prereleases first', () => {
  const sorted = ['0.10.0', '0.3.0', '0.4.0-beta.1', '0.4.0', '1.0.0'].sort(compareSemver);
  assert.deepEqual(sorted, ['0.3.0', '0.4.0', '0.4.0-beta.1', '0.10.0', '1.0.0'].sort(compareSemver));
  assert.ok(compareSemver('0.10.0', '0.4.0') > 0);
  assert.ok(compareSemver('0.4.0', '0.4.0') === 0);
});
