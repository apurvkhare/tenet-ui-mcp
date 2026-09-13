// Static checks the server runs itself over the supplied files (DESIGN.md §11 "tokens" and
// "deprecations" rows, plus the hand-built-element and contract rules of audit_code). Pure text
// scanning: no execution, no parsing beyond what a regex can do honestly.
import { resolveValue } from '../catalog/resolve.js';
import type { VersionData } from '../catalog/store.js';
import { similarity } from '../catalog/synonyms.js';

export type Severity = 'critical' | 'serious' | 'error' | 'warn' | 'info';

export interface Finding {
  check: string;
  rule: string;
  severity: Severity;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  fix: { hint: string; primitive?: string; token?: string; replacement?: string; guideline?: string; resource?: string };
  /** Stable id for delta reporting: check|rule|file|line|key. */
  id: string;
}

export interface SourceFile { path: string; content: string }

const RAW_ELEMENTS: Record<string, string> = { button: 'Button', input: 'TextInput', select: 'Select', textarea: 'Textarea', table: 'Table', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading', a: 'Link' };
const INPUT_TYPES: Record<string, string> = { checkbox: 'Checkbox', radio: 'RadioGroup', number: 'NumberInput', date: 'DatePicker', search: 'TextInput', email: 'TextInput', password: 'TextInput', text: 'TextInput' };
const SPACING_PROPS = /^(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|rowGap|columnGap|marginTop|marginRight|marginBottom|marginLeft|paddingTop|paddingRight|paddingBottom|paddingLeft)$/;

const fid = (parts: Array<string | number | undefined>): string => parts.filter((p) => p !== undefined && p !== '').join('|');

export function staticChecks(data: VersionData, files: SourceFile[], theme: 'light' | 'dark' = 'light'): Finding[] {
  const out: Finding[] = [];
  const known = new Set(data.tokens.map((t) => t.cssVar ?? `--${t.name}`));
  const componentIds = new Set(data.components.map((c) => c.id));
  const exportNames = new Set(data.components.flatMap((c) => [c.exportName, ...c.subcomponents.flatMap((s) => (s.exportName ? [s.exportName] : []))]));
  const has = (name: string): boolean => componentIds.has(name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
  const guideline = (id: string): string => `ds://${data.version}/guidelines/${id}`;

  for (const f of files) {
    const isStyle = /\.(css|scss|less)$/.test(f.path);
    const isJsx = /\.(tsx|jsx|js|ts|mjs|mts)$/.test(f.path);
    if (!isStyle && !isJsx) continue;
    const lines = f.content.split(/\r?\n/);
    let inBlockComment = false;
    lines.forEach((raw, i) => {
      const line = i + 1;
      let text = raw;
      // Strip comments crudely so commented-out code does not fire.
      if (inBlockComment) { const end = text.indexOf('*/'); if (end < 0) return; text = text.slice(end + 2); inBlockComment = false; }
      text = text.replace(/\/\*.*?\*\//g, '');
      if (text.includes('/*')) { text = text.slice(0, text.indexOf('/*')); inBlockComment = true; }
      text = text.replace(/\/\/.*$/, '');
      if (/^\s*import\b/.test(text)) return;

      // Raw colours.
      for (const m of text.matchAll(/(?<![\w&])(#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\([^)]*\)|hsla?\([^)]*\))/gi)) {
        const value = m[1]!;
        if (/^#[0-9a-f]{3,4}$/i.test(value) && !isStyle && !/(color|background|border|fill|stroke)/i.test(text)) continue; // #abc in JS is more often a hash than a colour
        const r = resolveValue(data.tokens, value, 'color', theme);
        out.push({ check: 'tokens', rule: 'tokens/no-raw-color', severity: 'error', file: f.path, line, column: m.index! + 1, message: `raw colour ${value}`, fix: { hint: r.token ? `use var(${r.cssVar}) (${r.tokenValue}, ΔE ${r.delta})${r.withinTolerance ? '' : ' — beyond tolerance: an exception or a new token, not a silent snap'}` : 'no colour tokens in this version', token: r.token, guideline: guideline('color') }, id: fid(['tokens', 'no-raw-color', f.path, line, value]) });
      }
      // Raw lengths on spacing / type / radius properties.
      const propRe = isStyle ? /([a-z-]+)\s*:\s*([^;{}]+)/gi : /\b([a-zA-Z]+)\s*:\s*(['"`]?)([^,}\n'"`]+)\2/g;
      for (const m of text.matchAll(propRe)) {
        const prop = m[1]!;
        const value = (isStyle ? m[2]! : m[3]!).trim();
        if (/var\(/.test(value)) continue;
        const kind = SPACING_PROPS.test(prop) ? 'space' : /^(font-size|fontSize)$/.test(prop) ? 'fontSize' : /^(border-radius|borderRadius)$/.test(prop) ? 'radius' : /^(font-weight|fontWeight)$/.test(prop) ? 'fontWeight' : undefined;
        if (!kind) continue;
        for (const v of value.split(/\s+/)) {
          if (!/^-?\d+(\.\d+)?(px|rem|em)?$/.test(v) || v === '0') continue;
          if (kind === 'fontWeight' && !/^\d{3}$/.test(v)) continue;
          if (kind !== 'fontWeight' && !isStyle && !/(px|rem|em)$/.test(v) && !/^\d+$/.test(v)) continue;
          const r = resolveValue(data.tokens, /^\d+(\.\d+)?$/.test(v) && kind !== 'fontWeight' ? `${v}px` : v, kind, theme);
          out.push({ check: 'tokens', rule: 'tokens/no-raw-spacing', severity: 'error', file: f.path, line, column: m.index! + 1, message: `raw ${prop}: ${v}`, fix: { hint: r.token ? `use var(${r.cssVar}) (${r.tokenValue}${r.delta ? `, Δ${r.delta}` : ''})` : `no ${kind} tokens in this version`, token: r.token, guideline: guideline(kind === 'space' ? 'layout' : 'typography') }, id: fid(['tokens', 'no-raw-spacing', f.path, line, prop, v]) });
        }
      }
      // Unknown tokens.
      for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
        const name = m[1]!;
        if (known.has(name)) continue;
        const nearest = [...known].map((k) => ({ k, s: similarity(name, k) })).sort((a, b) => b.s - a.s)[0];
        out.push({ check: 'tokens', rule: 'tokens/no-unknown-token', severity: 'error', file: f.path, line, column: m.index! + 1, message: `${name} is not a token in ${data.version}`, fix: { hint: nearest ? `did you mean var(${nearest.k})?` : 'see ds://…/tokens', token: nearest?.k.replace(/^--/, ''), resource: `ds://${data.version}/tokens/${name.slice(2).split('-')[0]}.json` }, id: fid(['tokens', 'no-unknown-token', f.path, line, name]) });
      }
      if (!isJsx) return;
      // Hand-built elements where a system component exists.
      for (const m of text.matchAll(/<(button|input|select|textarea|table|h[1-6]|a)\b([^>]*)/g)) {
        const tag = m[1]!;
        let target = RAW_ELEMENTS[tag]!;
        if (tag === 'input') { const t = m[2]!.match(/type\s*=\s*["'{]?\s*([a-z]+)/)?.[1]; if (t === 'hidden' || t === 'file' || t === 'submit') continue; target = (t && INPUT_TYPES[t]) || 'TextInput'; }
        if (tag === 'a' && !/href/.test(m[2]!)) continue;
        if (!has(target)) continue;
        out.push({ check: 'contract', rule: 'contract/prefer-component', severity: 'error', file: f.path, line, column: m.index! + 1, message: `raw <${tag}> where ${target} exists`, fix: { hint: `use <${target}> — import { ${target} } from '${data.manifest.package}'`, primitive: target, resource: `ds://${data.version}/components/${target.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}` }, id: fid(['contract', 'prefer-component', f.path, line, tag]) });
      }
      // Deprecated components and props (the migration registry for this version).
      for (const d of data.deprecations?.deprecations ?? []) {
        if (d.kind === 'component' && new RegExp(`<${d.component}\\b`).test(text)) {
          out.push({ check: 'deprecations', rule: 'deprecations/component', severity: 'error', file: f.path, line, message: `<${d.component}> is deprecated since ${d.since ?? '?'}`, fix: { hint: d.message ?? `use ${d.replacement}`, replacement: d.replacement, resource: `ds://${data.version}/deprecations` }, id: fid(['deprecations', 'component', f.path, line, d.component]) });
        }
        if (d.kind === 'prop' && d.prop && new RegExp(`<${d.component}\\b[^>]*\\s${d.prop}(?:[\\s=/>])`).test(text)) {
          out.push({ check: 'deprecations', rule: 'deprecations/prop', severity: 'error', file: f.path, line, message: `${d.prop} on <${d.component}> is deprecated since ${d.since ?? '?'}`, fix: { hint: d.message ?? `use ${d.replacement}`, replacement: d.replacement, resource: `ds://${data.version}/deprecations` }, id: fid(['deprecations', 'prop', f.path, line, d.component, d.prop]) });
        }
      }
      // Contract: onClick on non-interactive elements; images without alt; pixel margins between siblings.
      for (const m of text.matchAll(/<(div|span|li|p)\b[^>]*\bonClick\b/g)) {
        out.push({ check: 'a11y', rule: 'a11y/click-on-non-interactive', severity: 'error', file: f.path, line, column: m.index! + 1, message: `onClick on <${m[1]}>`, fix: { hint: 'use <Button> or <Link> so it is focusable and announced', primitive: 'Button', guideline: guideline('accessibility') }, id: fid(['a11y', 'click-on-non-interactive', f.path, line, m[1]]) });
      }
      for (const m of text.matchAll(/<img\b([^>]*)>/g)) {
        if (!/\balt\s*=/.test(m[1]!)) out.push({ check: 'a11y', rule: 'a11y/missing-alt', severity: 'critical', file: f.path, line, column: m.index! + 1, message: '<img> without alt', fix: { hint: 'add alt describing the image, or alt="" if decorative — never guess: ask', guideline: guideline('accessibility') }, id: fid(['a11y', 'missing-alt', f.path, line]) });
      }
      // Only judged when the tag closes on this line (nested `{<Icon />}` defeats a plain [^>]* match).
      const ib = text.indexOf('<IconButton');
      if (ib >= 0 && /\/>\s*$|\/>[^<]*$/.test(text.slice(ib)) && !/aria-label|aria-labelledby/.test(text.slice(ib))) {
        out.push({ check: 'a11y', rule: 'a11y/icon-only-without-name', severity: 'critical', file: f.path, line, message: '<IconButton> without aria-label', fix: { hint: 'IconButton needs aria-label: the icon is decorative, the control must carry the name', primitive: 'IconButton', guideline: guideline('iconography') }, id: fid(['a11y', 'icon-only-without-name', f.path, line]) });
      }
    });
    // Entry files must import the stylesheet (the runtime contract).
    if (isJsx && /(^|\/)(main|index|App|app|entry)\.[jt]sx?$/.test(f.path) && /createRoot|ReactDOM\.render|hydrateRoot/.test(f.content) && !new RegExp(`${data.manifest.package}/styles\\.css`).test(f.content)) {
      out.push({ check: 'contract', rule: 'contract/require-styles-import', severity: 'critical', file: f.path, line: 1, message: `entry file does not import ${data.manifest.package}/styles.css`, fix: { hint: `import '${data.manifest.package}/styles.css' once at the app root; without it every var(--token) is undefined and the UI renders unstyled`, resource: `ds://${data.version}/guidelines/contract` }, id: fid(['contract', 'require-styles-import', f.path]) });
    }
    // Unknown imports from the package.
    for (const m of f.content.matchAll(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${data.manifest.package}['"]`, 'g'))) {
      for (const name of m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!).filter(Boolean)) {
        if (!exportNames.has(name) && !/^(type|use[A-Z])/.test(name)) {
          const nearest = [...exportNames].map((k) => ({ k, s: similarity(name, k) })).sort((a, b) => b.s - a.s)[0];
          out.push({ check: 'types', rule: 'types/unknown-export', severity: 'error', file: f.path, line: f.content.slice(0, m.index).split('\n').length, message: `${data.manifest.package} ${data.version} does not export ${name}`, fix: { hint: nearest && nearest.s > 0.3 ? `did you mean ${nearest.k}?` : 'see ds://…/versions for what this version ships', primitive: nearest?.k, resource: `ds://${data.version}/gaps` }, id: fid(['types', 'unknown-export', f.path, name]) });
        }
      }
    }
  }
  return out;
}
