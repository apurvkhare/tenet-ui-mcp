// Cheap, honest source parsing shared by audit_code and plan_tests: imports from the package,
// exported component names, props interfaces (with their prop kinds), JSX tags used. Regex over
// text, not a TypeScript program — good enough to name what a file declares, never executed.
import type { SourceFile } from './static.js';

export interface ParsedProp { name: string; type: string; optional: boolean; kind: 'union' | 'boolean' | 'callback' | 'node' | 'string' | 'number' | 'other'; values?: string[] }
export interface ParsedInterface { name: string; exported: boolean; extends?: string; props: ParsedProp[]; line: number }
export interface ParsedComponent { name: string; line: number; forwardRef: boolean; propsType?: string; exported: boolean }
export interface ParsedSource {
  path: string;
  packageImports: string[];
  iconImports: string[];
  otherImports: Array<{ from: string; names: string[] }>;
  interfaces: ParsedInterface[];
  components: ParsedComponent[];
  /** JSX tags used, with counts (lowercase = DOM element, capitalised = component). */
  tags: Record<string, number>;
  storyExports: string[];
  storyTitle?: string;
  storyComponent?: string;
  isStories: boolean;
  isTest: boolean;
}

export function parseSource(file: SourceFile, pkg: string): ParsedSource {
  const text = stripComments(file.content);
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
  const packageImports: string[] = [];
  const iconImports: string[] = [];
  const otherImports: ParsedSource['otherImports'] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1]!.split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!).filter(Boolean);
    const from = m[2]!;
    if (from === pkg) packageImports.push(...names);
    else if (from === `${pkg}/icons`) iconImports.push(...names);
    else otherImports.push({ from, names });
  }
  const interfaces: ParsedInterface[] = [];
  for (const m of text.matchAll(/(export\s+)?(?:interface\s+([A-Z][A-Za-z0-9]*)(?:\s+extends\s+([^{]+))?|type\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:[^{;]*&\s*)?)\s*\{/g)) {
    const name = m[2] ?? m[4];
    if (!name) continue;
    const body = balanced(text, m.index! + m[0].length - 1);
    if (body === undefined) continue;
    interfaces.push({ name, exported: Boolean(m[1]), extends: m[3]?.trim(), props: parseProps(body), line: lineOf(m.index!) });
  }
  const components: ParsedComponent[] = [];
  for (const m of text.matchAll(/(export\s+)?(?:function\s+([A-Z][A-Za-z0-9]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)|const\s+([A-Z][A-Za-z0-9]*)\s*(?::[^=]+)?=\s*(forwardRef|React\.forwardRef|memo|React\.memo)?)/g)) {
    const name = m[2] ?? m[4];
    if (!name) continue;
    const after = text.slice(m.index!, m.index! + 400);
    const isComponent = /forwardRef|=>\s*\(?\s*<|return\s*\(?\s*<|\)\s*(?::\s*[A-Za-z.<>\[\]| ]+)?\s*\{/.test(after) && /<[A-Za-z]/.test(text.slice(m.index!, m.index! + 4000));
    if (!isComponent) continue;
    const propsType = (m[3] ?? '').match(/:\s*([A-Z][A-Za-z0-9]*Props)/)?.[1] ?? after.match(/forwardRef<[^,]+,\s*([A-Z][A-Za-z0-9]*)/)?.[1] ?? after.match(/\(\s*\{[^}]*\}\s*:\s*([A-Z][A-Za-z0-9]*)/)?.[1];
    components.push({ name, line: lineOf(m.index!), forwardRef: /forwardRef/.test(after.slice(0, 120)) || Boolean(m[5] && /forwardRef/.test(m[5])), propsType, exported: Boolean(m[1]) || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(text) || new RegExp(`export\\s+default\\s+${name}\\b`).test(text) });
  }
  const tags: Record<string, number> = {};
  for (const m of text.matchAll(/<([A-Za-z][A-Za-z0-9.]*)[\s/>]/g)) tags[m[1]!] = (tags[m[1]!] ?? 0) + 1;
  const isStories = /\.stories\.[jt]sx?$/.test(file.path);
  const isTest = /\.(test|spec)\.[jt]sx?$/.test(file.path);
  const storyExports = isStories ? [...text.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9]*)\s*(?::[^=]*)?=/g)].map((m) => m[1]!) : [];
  return {
    path: file.path, packageImports, iconImports, otherImports, interfaces, components, tags, storyExports,
    storyTitle: isStories ? text.match(/title\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] : undefined,
    storyComponent: isStories ? text.match(/component\s*:\s*([A-Z][A-Za-z0-9.]*)/)?.[1] : undefined,
    isStories, isTest,
  };
}

function parseProps(body: string): ParsedProp[] {
  const props: ParsedProp[] = [];
  // Split on top-level `;` or newlines; a prop line looks like `name?: type`.
  for (const raw of body.split(/[;\n]/)) {
    const m = raw.trim().match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*(.+)$/);
    if (!m) continue;
    const type = m[3]!.trim().replace(/,\s*$/, '');
    props.push({ name: m[1]!, type, optional: Boolean(m[2]), ...classify(m[1]!, type) });
  }
  return props;
}

function classify(name: string, type: string): { kind: ParsedProp['kind']; values?: string[] } {
  const literals = [...type.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!);
  if (literals.length >= 2 && /\|/.test(type)) return { kind: 'union', values: literals };
  if (type === 'boolean') return { kind: 'boolean' };
  if (/^on[A-Z]/.test(name) || /=>/.test(type)) return { kind: 'callback' };
  if (/ReactNode|ReactElement|JSX\.Element/.test(type)) return { kind: 'node' };
  if (type === 'string') return { kind: 'string' };
  if (type === 'number') return { kind: 'number' };
  return { kind: 'other' };
}

/** Text inside the braces starting at `open` (index of `{`), or undefined when unbalanced. */
export function balanced(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return undefined;
}

export function stripComments(text: string): string {
  // Keep line count stable: replace comment bodies with spaces (newlines preserved).
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}
