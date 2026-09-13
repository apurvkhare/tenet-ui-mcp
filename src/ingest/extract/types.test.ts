import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractTypes } from './types.js';

const FIXTURE = `
import * as react from 'react';
import { ButtonHTMLAttributes, ReactNode } from 'react';

/** Visual style. */
type ButtonVariant = 'default' | 'primary' | 'danger';
interface BaseProps {
  /** Extra class names. */
  className?: string;
}
interface ButtonProps extends BaseProps, ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style of the button. */
  variant?: ButtonVariant;
  /**
   * Stretch to the container.
   * @default false
   */
  fullWidth?: boolean;
  /**
   * Old name.
   * @deprecated Use \`fullWidth\` instead.
   */
  block?: boolean;
  /** Label. */
  children: ReactNode;
}
/** Action button. */
declare const Button: react.ForwardRefExoticComponent<ButtonProps & react.RefAttributes<HTMLButtonElement>>;

interface LabelProps { visuallyHidden?: boolean }
/** The field's label. */
declare const Label: react.ForwardRefExoticComponent<LabelProps & react.RefAttributes<HTMLLabelElement>>;
interface ItemProps { grow?: boolean }
interface FormControlProps { id?: string }
declare const FormControl: react.ForwardRefExoticComponent<FormControlProps & react.RefAttributes<HTMLDivElement>> & {
    Label: typeof Label;
    Item: react.ForwardRefExoticComponent<ItemProps & react.RefAttributes<HTMLDivElement>>;
};

interface ToastContextValue { show(): void }
/** Read the toast API. */
declare function useToast(): ToastContextValue;
interface PlainProps { title: string }
declare function Plain(props: PlainProps): react.JSX.Element;

export { Button, type ButtonProps, type ButtonVariant, FormControl, Plain, useToast };
`;

test('extractTypes reads components, props, unions, JSDoc tags and compound members from a .d.ts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenet-dts-'));
  const entry = join(dir, 'index.d.ts');
  writeFileSync(entry, FIXTURE);
  const out = extractTypes(entry);

  const names = out.components.map((c) => `${c.kind}:${c.name}`);
  assert.deepEqual(names, ['component:Button', 'component:FormControl', 'component:Plain', 'hook:useToast']);
  assert.deepEqual(out.types.map((t) => t.name), ['ButtonProps', 'ButtonVariant']);
  assert.deepEqual(out.unclassified, []);

  const button = out.components.find((c) => c.name === 'Button')!;
  assert.equal(button.description, 'Action button.');
  assert.equal(button.propsType, 'ButtonProps');
  assert.equal(button.refType, 'HTMLButtonElement');
  assert.deepEqual(button.extends, ['BaseProps', 'ButtonHTMLAttributes<HTMLButtonElement>']);
  const byName = Object.fromEntries(button.props.map((p) => [p.name, p]));
  assert.equal(byName.variant!.type, "'default' | 'primary' | 'danger'");
  assert.equal(byName.variant!.typeRef, 'ButtonVariant');
  assert.equal(byName.variant!.required, false);
  assert.equal(byName.fullWidth!.default, 'false');
  assert.equal(byName.block!.deprecated, 'Use `fullWidth` instead.');
  assert.equal(byName.children!.required, true);
  assert.equal(byName.className!.inheritedFrom, 'BaseProps');
  assert.equal(byName.className!.description, 'Extra class names.');

  const fc = out.components.find((c) => c.name === 'FormControl')!;
  assert.deepEqual(fc.subcomponents.map((s) => [s.name, s.kind, s.propsType, s.props.map((p) => p.name).join(','), s.description]), [
    ['FormControl.Label', 'component', 'LabelProps', 'visuallyHidden', "The field's label."],
    ['FormControl.Item', 'component', 'ItemProps', 'grow', ''],
  ]);

  const hook = out.components.find((c) => c.name === 'useToast')!;
  assert.equal(hook.returnType, 'ToastContextValue');
  assert.equal(hook.description, 'Read the toast API.');
  const plain = out.components.find((c) => c.name === 'Plain')!;
  assert.equal(plain.propsType, 'PlainProps');
  assert.equal(plain.props[0]!.required, true);
});
