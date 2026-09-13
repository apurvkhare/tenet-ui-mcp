// Types adapter: read the published `.d.ts` with the TypeScript compiler API (DESIGN.md §10, row
// "Types"). Works from the npm tarball alone; no source, no Storybook, no react-docgen. Structure
// (components, props, unions, required flags) comes from the types; JSDoc enriches it (descriptions,
// `@default`, `@deprecated`). Anything not expressible is left out rather than guessed.
import ts from 'typescript';

export interface ExtractedProp {
  name: string;
  /** Type as written, with local union aliases expanded (`'default' | 'primary'`). */
  type: string;
  /** Name of the local alias the type was written as, when it was one (`ButtonVariant`). */
  typeRef?: string;
  required: boolean;
  description: string;
  /** From `@default`. */
  default?: string;
  /** From `@deprecated` (the tag's text, or "deprecated" when it has none). */
  deprecated?: string;
  /** Set when the prop comes from a local interface this one extends. Foreign bases (React) are only named in `extends`. */
  inheritedFrom?: string;
}

export interface ExtractedPropsType {
  name: string;
  extends: string[];
  props: ExtractedProp[];
  description: string;
}

export interface ExtractedSubcomponent {
  name: string; // "FormControl.Label"
  kind: 'component' | 'hook' | 'function';
  propsType?: string;
  props: ExtractedProp[];
  description: string;
}

export interface ExtractedComponent {
  name: string;
  kind: 'component' | 'hook' | 'function';
  description: string;
  propsType?: string;
  refType?: string;
  extends: string[];
  props: ExtractedProp[];
  subcomponents: ExtractedSubcomponent[];
  /** For hooks/functions: the declared return type. */
  returnType?: string;
  file: string;
}

export interface ExtractedTypeAlias {
  name: string;
  kind: 'alias' | 'interface' | 'enum';
  text: string;
  description: string;
  file: string;
}

export interface ExtractedTypes {
  entry: string;
  typescript: string;
  components: ExtractedComponent[];
  /** Every exported type that is not a component (unions, prop interfaces, helper types). */
  types: ExtractedTypeAlias[];
  /** Names the entry exports that were neither classified as components nor types (for gap reporting). */
  unclassified: string[];
}

type TypeDecl = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration;

export function extractTypes(entryDts: string): ExtractedTypes {
  const program = ts.createProgram([entryDts], {
    noEmit: true,
    skipLibCheck: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(entryDts);
  if (!entry) throw new Error(`cannot load ${entryDts}`);

  // Every locally declared type across the entry and its chunks, by name (first declaration wins),
  // plus every local `declare const` / `declare function` so `typeof X` members of compound
  // components (`FormControl & { Label: typeof Label }`) can be followed.
  const decls = new Map<string, TypeDecl>();
  const values = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile && /node_modules|lib\.[a-z0-9.]+\.d\.ts$/.test(sf.fileName) && sf !== entry) continue;
    sf.forEachChild((node) => {
      if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name && !decls.has(node.name.text)) {
        decls.set(node.name.text, node);
      } else if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name) && !values.has(d.name.text)) values.set(d.name.text, d);
      } else if (ts.isFunctionDeclaration(node) && node.name && !values.has(node.name.text)) {
        values.set(node.name.text, node);
      }
    });
  }

  const moduleSymbol = checker.getSymbolAtLocation(entry);
  const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  const components: ExtractedComponent[] = [];
  const types: ExtractedTypeAlias[] = [];
  const unclassified: string[] = [];

  for (const sym of exports) {
    const exportName = sym.name;
    const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const decl = resolved.declarations?.[0];
    if (!decl) { unclassified.push(exportName); continue; }
    const file = relFile(decl.getSourceFile().fileName, entryDts);

    if (ts.isVariableDeclaration(decl) && decl.type) {
      const shape = analyzeComponentType(decl.type, values);
      if (shape) {
        const propsType = shape.propsType;
        const pt = propsType ? resolvePropsType(propsType, decls) : undefined;
        components.push({
          name: exportName,
          kind: 'component',
          description: jsdocDescription(decl),
          propsType,
          refType: shape.refType,
          extends: pt?.extends ?? [],
          props: pt?.props ?? [],
          subcomponents: shape.subcomponents.map((s) => {
            const spt = s.propsType ? resolvePropsType(s.propsType, decls) : undefined;
            return { name: `${exportName}.${s.name}`, kind: s.kind, propsType: s.propsType, props: spt?.props ?? [], description: s.description };
          }),
          file,
        });
        continue;
      }
    }
    if (ts.isFunctionDeclaration(decl)) {
      const isHook = /^use[A-Z]/.test(exportName);
      const firstParam = decl.parameters[0]?.type;
      const propsType = !isHook && firstParam && ts.isTypeReferenceNode(firstParam) ? firstParam.typeName.getText() : undefined;
      const pt = propsType ? resolvePropsType(propsType, decls) : undefined;
      components.push({
        name: exportName,
        kind: isHook ? 'hook' : propsType ? 'component' : 'function',
        description: jsdocDescription(decl),
        propsType,
        extends: pt?.extends ?? [],
        props: pt?.props ?? [],
        subcomponents: [],
        returnType: decl.type?.getText(),
        file,
      });
      continue;
    }
    if (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl)) {
      types.push({
        name: exportName,
        kind: ts.isInterfaceDeclaration(decl) ? 'interface' : ts.isEnumDeclaration(decl) ? 'enum' : 'alias',
        text: ts.isTypeAliasDeclaration(decl) ? decl.type.getText() : decl.getText().slice(0, 4000),
        description: jsdocDescription(decl),
        file,
      });
      continue;
    }
    unclassified.push(exportName);
  }

  components.sort((a, b) => a.name.localeCompare(b.name));
  types.sort((a, b) => a.name.localeCompare(b.name));
  return { entry: entryDts, typescript: ts.version, components, types, unclassified };
}

// ---- component type shapes ------------------------------------------------------------------
interface ComponentShape {
  propsType?: string;
  refType?: string;
  subcomponents: Array<{ name: string; kind: 'component' | 'hook' | 'function'; propsType?: string; description: string }>;
}

const COMPONENT_TYPES = /(^|\.)(ForwardRefExoticComponent|FC|FunctionComponent|ComponentType|MemoExoticComponent|NamedExoticComponent|ExoticComponent)$/;

type ValueDecls = Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>;

/** Recognise `ForwardRefExoticComponent<Props & RefAttributes<E>>`, `FC<Props>`, `(props: Props) => …`, `typeof LocalConst`, optionally `& { Sub: … }`. */
function analyzeComponentType(node: ts.TypeNode, values: ValueDecls, depth = 0): ComponentShape | undefined {
  if (depth > 4) return undefined;
  if (ts.isTypeQueryNode(node)) {
    // `typeof Label`: follow the local declaration.
    const target = values.get(node.exprName.getText());
    if (!target) return undefined;
    if (ts.isVariableDeclaration(target)) return target.type ? analyzeComponentType(target.type, values, depth + 1) : undefined;
    const p = target.parameters[0]?.type;
    return { propsType: p && ts.isTypeReferenceNode(p) ? p.typeName.getText() : undefined, subcomponents: [] };
  }
  const parts = ts.isIntersectionTypeNode(node) ? [...node.types] : [node];
  let shape: ComponentShape | undefined;
  const subs: ComponentShape['subcomponents'] = [];
  for (const part of parts) {
    if (ts.isTypeReferenceNode(part) && COMPONENT_TYPES.test(part.typeName.getText())) {
      const arg = part.typeArguments?.[0];
      shape = { propsType: undefined, refType: undefined, subcomponents: [] };
      if (arg) {
        const argParts = ts.isIntersectionTypeNode(arg) ? [...arg.types] : [arg];
        for (const a of argParts) {
          if (!ts.isTypeReferenceNode(a)) continue;
          const n = a.typeName.getText();
          if (/(^|\.)RefAttributes$/.test(n)) shape.refType = a.typeArguments?.[0]?.getText();
          else if (!shape.propsType) shape.propsType = n;
        }
      }
    } else if (ts.isFunctionTypeNode(part)) {
      const p = part.parameters[0]?.type;
      shape = { propsType: p && ts.isTypeReferenceNode(p) ? p.typeName.getText() : undefined, subcomponents: [] };
    } else if (ts.isTypeLiteralNode(part)) {
      for (const m of part.members) {
        if (!ts.isPropertySignature(m) || !m.type) continue;
        const memberName = m.name.getText();
        const inner = analyzeComponentType(m.type, values, depth + 1);
        // Description: the member's own JSDoc, else the JSDoc of the `typeof` target.
        const target = ts.isTypeQueryNode(m.type) ? values.get(m.type.exprName.getText()) : undefined;
        const description = jsdocDescription(m) || (target ? jsdocDescription(target) : '');
        const kind: ComponentShape['subcomponents'][number]['kind'] = /^use[A-Z]/.test(memberName) ? 'hook' : inner ? 'component' : 'function';
        subs.push({ name: memberName, kind, propsType: inner?.propsType, description });
      }
    }
  }
  if (!shape) return undefined;
  shape.subcomponents = subs;
  return shape;
}

// ---- props --------------------------------------------------------------------------------
function resolvePropsType(name: string, decls: Map<string, TypeDecl>, seen = new Set<string>()): ExtractedPropsType | undefined {
  const decl = decls.get(name);
  if (!decl || seen.has(name)) return undefined;
  seen.add(name);
  const out: ExtractedPropsType = { name, extends: [], props: [], description: jsdocDescription(decl) };

  const addMembers = (members: ts.NodeArray<ts.TypeElement>, inheritedFrom?: string): void => {
    for (const m of members) {
      if (!(ts.isPropertySignature(m) || ts.isMethodSignature(m))) continue;
      const propName = ts.isComputedPropertyName(m.name) ? m.name.getText() : (m.name as ts.Identifier | ts.StringLiteral).text;
      const tags = jsdocTags(m);
      const typeNode = ts.isPropertySignature(m) ? m.type : undefined;
      const written = typeNode ? typeNode.getText() : ts.isMethodSignature(m) ? m.getText().replace(/^[^(]*/, '') : 'unknown';
      const { type, typeRef } = expandAlias(written, typeNode, decls);
      const prop: ExtractedProp = {
        name: propName,
        type,
        required: !m.questionToken,
        description: jsdocDescription(m),
      };
      if (typeRef) prop.typeRef = typeRef;
      if (tags.default !== undefined) prop.default = tags.default;
      if (tags.deprecated !== undefined) prop.deprecated = tags.deprecated || 'deprecated';
      if (inheritedFrom) prop.inheritedFrom = inheritedFrom;
      if (!out.props.some((p) => p.name === prop.name)) out.props.push(prop);
    }
  };

  if (ts.isInterfaceDeclaration(decl)) {
    addMembers(decl.members);
    for (const clause of decl.heritageClauses ?? []) {
      for (const t of clause.types) {
        const text = t.getText();
        out.extends.push(text);
        const baseName = t.expression.getText();
        const base = decls.has(baseName) ? resolvePropsType(baseName, decls, seen) : undefined;
        if (base) for (const p of base.props) if (!out.props.some((x) => x.name === p.name)) out.props.push({ ...p, inheritedFrom: p.inheritedFrom ?? baseName });
      }
    }
  } else if (ts.isTypeAliasDeclaration(decl)) {
    const parts = ts.isIntersectionTypeNode(decl.type) ? [...decl.type.types] : [decl.type];
    for (const part of parts) {
      if (ts.isTypeLiteralNode(part)) addMembers(part.members);
      else if (ts.isTypeReferenceNode(part)) {
        const refName = part.typeName.getText();
        const base = decls.has(refName) ? resolvePropsType(refName, decls, seen) : undefined;
        if (base) for (const p of base.props) if (!out.props.some((x) => x.name === p.name)) out.props.push({ ...p, inheritedFrom: p.inheritedFrom ?? refName });
        else out.extends.push(part.getText());
      } else out.extends.push(part.getText());
    }
  }
  return out;
}

/** `variant?: ButtonVariant` → type `'default' | 'primary' | …`, typeRef `ButtonVariant` (one level, unions of literals only). */
function expandAlias(written: string, typeNode: ts.TypeNode | undefined, decls: Map<string, TypeDecl>): { type: string; typeRef?: string } {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || typeNode.typeArguments?.length) return { type: written };
  const name = typeNode.typeName.getText();
  const decl = decls.get(name);
  if (!decl || !ts.isTypeAliasDeclaration(decl)) return { type: written };
  const t = decl.type;
  const isLiteralUnion = ts.isUnionTypeNode(t) && t.types.every((u) => ts.isLiteralTypeNode(u) || u.kind === ts.SyntaxKind.NumberKeyword || u.kind === ts.SyntaxKind.StringKeyword || u.kind === ts.SyntaxKind.BooleanKeyword);
  if (isLiteralUnion || ts.isLiteralTypeNode(t)) return { type: t.getText().replace(/\s*\n\s*/g, ' '), typeRef: name };
  return { type: written, typeRef: name };
}

// ---- JSDoc --------------------------------------------------------------------------------
function jsdocNodes(node: ts.Node): ts.JSDoc[] {
  // `declare const X` carries its JSDoc on the VariableStatement, two levels up.
  let n: ts.Node | undefined = node;
  while (n && !(n as { jsDoc?: ts.JSDoc[] }).jsDoc && (ts.isVariableDeclaration(n) || ts.isVariableDeclarationList(n))) n = n.parent;
  return (n as { jsDoc?: ts.JSDoc[] } | undefined)?.jsDoc ?? [];
}
function jsdocDescription(node: ts.Node): string {
  const docs = jsdocNodes(node);
  const last = docs[docs.length - 1];
  const c = last?.comment;
  return (typeof c === 'string' ? c : c ? ts.getTextOfJSDocComment(c) ?? '' : '').trim();
}
function jsdocTags(node: ts.Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const doc of jsdocNodes(node)) {
    for (const tag of doc.tags ?? []) {
      const name = tag.tagName.text;
      const c = tag.comment;
      out[name] = (typeof c === 'string' ? c : c ? ts.getTextOfJSDocComment(c) ?? '' : '').trim();
    }
  }
  return out;
}

function relFile(file: string, entry: string): string {
  const base = entry.replace(/[^/\\]+$/, '');
  return file.startsWith(base) ? file.slice(base.length) : file;
}
