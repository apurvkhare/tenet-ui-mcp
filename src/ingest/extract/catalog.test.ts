import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCatalog, type ShippedCatalog } from './catalog.js';
import type { ExtractedComponent, ExtractedTypes } from './types.js';

const comp = (name: string, props: string[], extra: Partial<ExtractedComponent> = {}): ExtractedComponent => ({
  name,
  kind: 'component',
  description: '',
  propsType: `${name}Props`,
  extends: [],
  props: props.map((p) => ({ name: p, type: 'string', required: false, description: '' })),
  subcomponents: [],
  file: 'index.d.ts',
  ...extra,
});

const extracted: ExtractedTypes = {
  entry: 'index.d.ts',
  typescript: '5.x',
  components: [
    comp('Button', ['variant', 'fullWidth', 'block'], { props: [
      { name: 'variant', type: "'a' | 'b'", required: false, description: '' },
      { name: 'fullWidth', type: 'boolean', required: false, description: '' },
      { name: 'block', type: 'boolean', required: false, description: '', deprecated: 'use fullWidth' },
      { name: 'className', type: 'string', required: false, description: '', inheritedFrom: 'Base' },
    ] }),
    comp('Radio', ['value']),
    comp('RadioGroup', ['name']),
    comp('ToastProvider', ['placement']),
    { ...comp('useToast', []), kind: 'hook', propsType: undefined, returnType: 'ToastContextValue' },
    comp('Orphan', ['x']),
  ],
  types: [],
  unclassified: [],
};

const shipped: ShippedCatalog = {
  schemaVersion: 2,
  package: 'tenet-ui',
  version: '0.4.0',
  components: {
    button: { id: 'button', name: 'Button', status: 'stable', a11yReviewed: true, props: [{ name: 'variant' }, { name: 'fullWidth' }, { name: 'block', deprecated: 'x' }, { name: 'ghost' }], stories: [{ id: 'components-button--default', name: 'Default' }], related: ['link'] },
    'radio-group': { id: 'radio-group', name: 'RadioGroup', status: 'stable', a11yReviewed: true, props: [{ name: 'name' }], subcomponents: [{ id: 'radio', name: 'Radio' }] },
    toast: { id: 'toast', name: 'Toast', status: 'stable', a11yReviewed: true, props: [{ name: 'placement' }], subcomponents: [{ name: 'ToastProvider' }, { name: 'useToast', kind: 'hook' }] },
    ghost: { id: 'ghost', name: 'Ghost', status: 'stable', props: [] },
  },
};

test('mergeCatalog: props from types, curation from the package, sibling exports folded into their parent', () => {
  const { components, mismatches } = mergeCatalog(extracted, shipped, 'tenet-ui', (id) => id === 'button');
  const ids = components.map((c) => c.id);
  assert.deepEqual(ids, ['button', 'orphan', 'radio-group', 'toast']);

  const button = components.find((c) => c.id === 'button')!;
  assert.equal(button.status, 'stable');
  assert.equal(button.guidelines, 'guidelines/button.md');
  assert.deepEqual(button.stories.map((s) => s.id), ['components-button--default']);
  assert.equal(button.props.length, 4); // inherited kept, flagged
  assert.equal(button.props.find((p) => p.name === 'className')!.inheritedFrom, 'Base');

  const radio = components.find((c) => c.id === 'radio-group')!;
  assert.deepEqual(radio.subcomponents.map((s) => [s.id, s.name, s.exportName, s.props.map((p) => p.name).join()]), [['radio', 'Radio', 'Radio', 'value']]);

  const toast = components.find((c) => c.id === 'toast')!;
  assert.equal(toast.name, 'Toast');
  assert.equal(toast.exportName, 'ToastProvider');
  assert.deepEqual(toast.props.map((p) => p.name), ['placement']);
  assert.deepEqual(toast.subcomponents.map((s) => [s.name, s.kind]), [['useToast', 'hook']]);

  const orphan = components.find((c) => c.id === 'orphan')!;
  assert.equal(orphan.status, 'unlisted');
  assert.equal(orphan.provenance.curation, 'none');

  assert.deepEqual(mismatches.map((m) => `${m.kind}:${m.component}:${m.detail}`).sort(), [
    'component-only-in-catalog:Ghost:listed in generated/components.json but not exported from the .d.ts',
    'component-only-in-types:Orphan:exported from the package but absent from generated/components.json',
    'prop-only-in-catalog:Button:ghost',
  ]);
});

test('mergeCatalog without a shipped catalog: every export becomes an unlisted entry, no mismatches', () => {
  const { components, mismatches } = mergeCatalog(extracted, undefined, 'tenet-ui', () => false);
  assert.equal(components.length, 6);
  assert.ok(components.every((c) => c.provenance.curation === 'none'));
  assert.deepEqual(mismatches.filter((m) => m.kind !== 'component-only-in-types'), []);
});
