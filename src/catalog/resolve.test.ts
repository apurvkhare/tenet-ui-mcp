import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticChecks } from '../checks/static.js';
import { colorRoleFor, resolveValue } from './resolve.js';
import { CatalogStore } from './store.js';

const data = new CatalogStore('snapshots').load('0.4.0');

test('colorRoleFor reads the role from CSS and style-object property names', () => {
  assert.equal(colorRoleFor('background'), 'background');
  assert.equal(colorRoleFor('background-color'), 'background');
  assert.equal(colorRoleFor('backgroundColor'), 'background');
  assert.equal(colorRoleFor('color'), 'foreground');
  assert.equal(colorRoleFor('borderColor'), 'border');
  assert.equal(colorRoleFor('border-top-color'), 'border');
  assert.equal(colorRoleFor('border'), 'border');
  assert.equal(colorRoleFor('fill'), undefined);
  assert.equal(colorRoleFor(undefined), undefined);
});

test('a colour resolves among the tokens of its role (color guideline §1)', () => {
  // #ffffff is both fgColor-onEmphasis and bgColor-default; the role decides.
  assert.equal(resolveValue(data.tokens, '#ffffff', 'color', 'light', 'background').token, 'bgColor-default');
  assert.equal(resolveValue(data.tokens, '#ffffff', 'color', 'light', 'foreground').token, 'fgColor-onEmphasis');
  const border = resolveValue(data.tokens, '#ffffff', 'color', 'light', 'border');
  assert.ok(border.token?.startsWith('borderColor-'), border.token);
  assert.match(border.note ?? '', /nearest borderColor token/);
  // No role: every semantic token, as before.
  assert.ok(resolveValue(data.tokens, '#ffffff', 'color', 'light').exact);
});

test('the static scan takes the role from the property the colour is assigned to', () => {
  const f = staticChecks(data, [{ path: 'src/Box.css', content: '.box {\n  background: #ffffff;\n  color: #ffffff;\n}\n' }]);
  const colors = f.filter((x) => x.rule === 'tokens/no-raw-color');
  assert.deepEqual(colors.map((x) => [x.line, x.fix?.token]), [[2, 'bgColor-default'], [3, 'fgColor-onEmphasis']]);
});
