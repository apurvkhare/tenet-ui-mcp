// Contract rules of audit_code (DESIGN.md §5, content/audit-rules.md) that need a little more
// than a line regex: boolean prop explosions, components that do not forward refs, system
// primitives re-styled with raw values. Still text-level, still never executed.
import type { VersionData } from '../catalog/store.js';
import { parseSource } from './source.js';
import type { Finding, SourceFile } from './static.js';

const fid = (parts: Array<string | number | undefined>): string => parts.filter((p) => p !== undefined && p !== '').join('|');
const RAW_VALUE = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b\d+(?:\.\d+)?(?:px|rem|em)\b/i;

export function contractChecks(data: VersionData, files: SourceFile[]): Finding[] {
  const out: Finding[] = [];
  const pkg = data.manifest.package;
  const primitives = new Set(data.components.flatMap((c) => [c.exportName, ...c.subcomponents.flatMap((s) => (s.exportName ? [s.exportName] : []))]));
  const contract = `ds://${data.version}/guidelines/contract`;
  const cssFiles = files.filter((f) => /\.(css|scss|less)$/.test(f.path));

  for (const f of files) {
    if (!/\.(tsx|jsx|ts|js|mjs|mts)$/.test(f.path)) continue;
    const src = parseSource(f, pkg);
    if (src.isStories || src.isTest) continue;

    // Boolean explosion: three or more boolean props on one exported props interface.
    for (const i of src.interfaces) {
      const booleans = i.props.filter((p) => p.kind === 'boolean').map((p) => p.name);
      if (booleans.length >= 3) out.push({ check: 'contract', rule: 'contract/boolean-explosion', severity: 'warn', file: f.path, line: i.line, message: `${i.name} has ${booleans.length} boolean props (${booleans.join(', ')})`, fix: { hint: `collapse related booleans into one union prop, e.g. variant: '${booleans.slice(0, 3).map((b) => b.replace(/^is/, '').toLowerCase()).join("' | '")}'`, guideline: contract }, id: fid(['contract', 'boolean-explosion', f.path, i.name]) });
    }
    // Missing forwardRef: an exported component that renders a DOM element or a system primitive.
    for (const c of src.components) {
      if (!c.exported || c.forwardRef) continue;
      const rendersElement = Object.keys(src.tags).some((t) => /^[a-z]/.test(t) || primitives.has(t));
      if (!rendersElement) continue;
      out.push({ check: 'contract', rule: 'contract/missing-forward-ref', severity: 'warn', file: f.path, line: c.line, message: `${c.name} does not forward its ref`, fix: { hint: `export const ${c.name} = forwardRef<HTMLElement, ${c.propsType ?? `${c.name}Props`}>(function ${c.name}({ className, ...rest }, ref) { … }) — forward to the real element and spread rest`, guideline: contract }, id: fid(['contract', 'missing-forward-ref', f.path, c.name]) });
    }
    // Restyled primitive: a system component with an inline style carrying raw values.
    const lines = f.content.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/<([A-Z][A-Za-z0-9]*)(?:\.[A-Z][A-Za-z0-9]*)?\b[^>]*?\bstyle=\{\{([^}]*)\}\}/g)) {
        if (!primitives.has(m[1]!)) continue;
        if (!RAW_VALUE.test(m[2]!)) continue;
        out.push({ check: 'contract', rule: 'contract/restyled-primitive', severity: 'error', file: f.path, line: i + 1, column: m.index! + 1, message: `<${m[1]}> re-styled inline with raw values (${m[2]!.trim().slice(0, 60)})`, fix: { hint: `use a ${m[1]} variant or size prop, or a var(--token); never restyle a primitive with raw values`, primitive: m[1], guideline: contract, resource: `ds://${data.version}/components/${m[1]!.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}` }, id: fid(['contract', 'restyled-primitive', f.path, i + 1, m[1]]) });
      }
    });
  }
  // Restyled primitive via CSS: a selector targeting the system's own class names with raw values.
  for (const f of cssFiles) {
    const lines = f.content.split(/\r?\n/);
    let selector: string | undefined;
    let selectorLine = 0;
    lines.forEach((line, i) => {
      const sel = line.match(/^\s*([^{}]*\.Tenet-[A-Za-z0-9_-]+[^{}]*)\{/);
      if (sel) { selector = sel[1]!.trim(); selectorLine = i + 1; return; }
      if (/\}/.test(line)) { selector = undefined; return; }
      if (selector && /:\s*[^;]*(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b\d+(?:\.\d+)?(?:px|rem|em)\b)/i.test(line) && !/var\(--/.test(line)) {
        out.push({ check: 'contract', rule: 'contract/restyled-primitive', severity: 'error', file: f.path, line: i + 1, message: `${selector} (line ${selectorLine}) overrides a system primitive with a raw value: ${line.trim().slice(0, 60)}`, fix: { hint: 'do not target Tenet-* classes; use the component\'s variant/size props or wrap it', guideline: contract }, id: fid(['contract', 'restyled-primitive', f.path, i + 1]) });
      }
    });
  }
  return out;
}
