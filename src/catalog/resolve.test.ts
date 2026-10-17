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

test('a colour prefers the tokens of its role (color guideline §1), and takes another role\'s exact match when its own has none', () => {
  // #ffffff is both fgColor-onEmphasis and bgColor-default; the role decides.
  assert.equal(resolveValue(data.tokens, '#ffffff', 'color', 'light', 'background').token, 'bgColor-default');
  assert.equal(resolveValue(data.tokens, '#ffffff', 'color', 'light', 'foreground').token, 'fgColor-onEmphasis');
  // Near a borderColor token: the border group wins.
  const muted = resolveValue(data.tokens, '#ddd2be', 'color', 'light', 'border');
  assert.equal(muted.token, 'borderColor-default');
  assert.match(muted.note ?? '', /nearest borderColor token/);
  // A border in the danger red: tenet-ui draws it with fgColor-danger (no danger border token), so
  // the exact match from another role wins over a distant borderColor token.
  const danger = resolveValue(data.tokens, '#8a2817', 'color', 'light', 'border');
  assert.equal(danger.token, 'fgColor-danger');
  assert.ok(danger.exact);
  // No role: every semantic token, as before.
  assert.ok(resolveValue(data.tokens, '#ffffff', 'color', 'light').exact);
});

test('the static scan takes the role from the property the colour is assigned to', () => {
  const f = staticChecks(data, [{ path: 'src/Box.css', content: '.box {\n  background: #ffffff;\n  color: #ffffff;\n}\n' }]);
  const colors = f.filter((x) => x.rule === 'tokens/no-raw-color');
  assert.deepEqual(colors.map((x) => [x.line, x.fix?.token]), [[2, 'bgColor-default'], [3, 'fgColor-onEmphasis']]);
});

test('a themed shadow resolves per theme (tenet-ui themes shadow-focus since its DTCG 2025.10 source)', () => {
  // The record shape tenet-ui's build emits once shadow.focus lives under themes.light / themes.dark.
  const themedFocus = { name: 'shadow-focus', cssVar: '--shadow-focus', type: 'shadow', path: ['shadow', 'focus'], description: 'Focus ring halo for fields.', themed: true, light: '0 0 0 3px #f5e4db', dark: '0 0 0 3px #3a2117' };
  const tokens = [...data.tokens.filter((t) => t.name !== 'shadow-focus'), themedFocus];
  const light = resolveValue(tokens, '0 0 0 3px #f5e4db', 'shadow', 'light');
  assert.equal(light.token, 'shadow-focus');
  assert.ok(light.exact);
  assert.equal(resolveValue(tokens, '0 0 0 3px #3a2117', 'shadow', 'dark').token, 'shadow-focus');
  // The light halo is not the dark token's value.
  assert.equal(resolveValue(tokens, '0 0 0 3px #f5e4db', 'shadow', 'dark').exact, false);
  // Unthemed shadows still resolve in either theme.
  assert.equal(resolveValue(tokens, '0 1px 2px rgba(31, 27, 22, 0.06)', 'shadow', 'dark').token, 'shadow-resting');
});
