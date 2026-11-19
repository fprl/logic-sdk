// Reads the app's source with a real parser (oxc): which functions run which, what they emit,
// what each file imports. No regex, and no code is executed here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";

export interface Loc {
  file: string; // relative to the project root
  line: number;
  column: number;
}
export interface Edge {
  to: string; // "availability.hold", or "(dynamic)" when it can't be resolved statically
  at: Loc;
}
/** An `export const name = …(…)` in a module file. Matched against the registry by id, so definer names don't matter. */
export interface SourceFn {
  id: string;
  at: Loc;
  expose?: string; // policy name, "inline", or undefined (internal)
  runs: Edge[];
  emits: Edge[];
  fetches: Loc[]; // fetch(...) calls
  dates: Loc[]; // new Date() / Date.now()
}
export interface SourceImport {
  from: string; // module that imports
  spec: string;
  target: string; // module it reaches
  internal: boolean; // reaches a file other than the module's index
  at: Loc;
}
export interface Source {
  /** `folder: false`: the module is a single file (fine for small modules). */
  modules: Record<string, { dir: string; index: string; folder: boolean }>;
  fns: Map<string, SourceFn>;
  imports: SourceImport[];
}

type Node = { type: string; start: number; [key: string]: any };
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"]);
const unwrap = (n: Node | undefined): Node | undefined => (n && WRAPPERS.has(n.type) ? unwrap(n.expression) : n);

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const key in n) if (key !== "parent") walk(n[key], visit);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec|d)\.[mt]?tsx?$/.test(name) ? [path] : [];
  });
}

export class ParseError extends Error {}

export function analyze(root: string, registryFile: string): Source {
  const resolver = new ResolverFactory({ extensions: [".ts", ".tsx", ".mts", ".js"], mainFiles: ["index"] });
  const resolve = (fromFile: string, spec: string) => resolver.sync(dirname(fromFile), spec).path;
  const read = (file: string) => {
    const text = readFileSync(file, "utf8");
    const result = parseSync(file, text);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const loc = (offset: number): Loc => {
      let line = lineStarts.findIndex((start) => start > offset);
      if (line === -1) line = lineStarts.length;
      return { file: relative(root, file), line, column: offset - lineStarts[line - 1]! + 1 };
    };
    return { program: result.program as unknown as Node, loc };
  };

  // registry.ts: `import * as bookings from "./bookings"` + `modules: { bookings, ... }`
  const reg = read(registryFile);
  const namespaces: Record<string, string> = {};
  for (const s of reg.program.body)
    if (s.type === "ImportDeclaration" && s.specifiers[0]?.type === "ImportNamespaceSpecifier") {
      const index = resolve(registryFile, s.source.value);
      if (index) namespaces[s.specifiers[0].local.name] = index;
    }
  const modules: Source["modules"] = {};
  walk(reg.program, (n) => {
    if (n.type !== "Property" || n.key?.name !== "modules" || n.value?.type !== "ObjectExpression") return;
    for (const p of n.value.properties) {
      const index = p.value?.type === "Identifier" ? namespaces[p.value.name] : undefined;
      if (!p.key?.name || !index) continue;
      const folder = /^index\.[mc]?tsx?$/.test(basename(index));
      modules[p.key.name] = { index, folder, dir: folder ? dirname(index) : index };
    }
  });
  if (!Object.keys(modules).length)
    throw new ParseError(
      `Couldn't find the modules in ${relative(root, registryFile)}. Expected createRegistry({ modules: { bookings, ... } }) with each module imported as \`import * as bookings from "./bookings"\`.`,
    );

  const moduleOf = (file: string) =>
    Object.entries(modules).find(([, m]) => file === m.dir || (m.folder && file.startsWith(m.dir + sep)))?.[0];

  const fns = new Map<string, SourceFn>();
  const imports: SourceImport[] = [];

  for (const [mod, { dir, folder, index }] of Object.entries(modules)) {
    for (const file of folder ? sourceFiles(dir) : [index]) {
      const { program, loc } = read(file);

      // what each local name refers to: another module's namespace, or a name in some module
      const local: Record<string, { mod: string; ns: boolean }> = {};
      for (const s of program.body) {
        if (s.type !== "ImportDeclaration" || !s.source.value.startsWith(".")) continue;
        const resolved = resolve(file, s.source.value);
        const target = resolved ? moduleOf(resolved) : undefined;
        if (!resolved || !target) continue;
        for (const sp of s.specifiers) local[sp.local.name] = { mod: target, ns: sp.type === "ImportNamespaceSpecifier" };
        if (target !== mod)
          imports.push({ from: mod, spec: s.source.value, target, internal: resolved !== modules[target]!.index, at: loc(s.start) });
      }
      const nameOf = (arg: Node | undefined): string => {
        if (arg?.type === "MemberExpression" && arg.object?.type === "Identifier" && local[arg.object.name]?.ns)
          return `${local[arg.object.name]!.mod}.${arg.property.name}`;
        if (arg?.type === "Identifier") return `${local[arg.name]?.mod ?? mod}.${arg.name}`;
        return "(dynamic)";
      };

      for (const s of program.body) {
        const decl = s.type === "ExportNamedDeclaration" ? s.declaration?.declarations?.[0] : undefined;
        const call = unwrap(decl?.init);
        if (call?.type !== "CallExpression" || decl.id?.type !== "Identifier") continue;
        const fn: SourceFn = { id: `${mod}.${decl.id.name}`, at: loc(decl.start), runs: [], emits: [], fetches: [], dates: [] };

        const def = call.arguments[0];
        const expose = def?.type === "ObjectExpression" ? def.properties.find((p: Node) => p.key?.name === "expose")?.value : undefined;
        if (expose) fn.expose = expose.type === "Literal" ? String(expose.value) : "inline";

        walk(call.arguments, (n) => {
          if (n.type === "NewExpression" && n.callee?.name === "Date" && n.arguments.length === 0) fn.dates.push(loc(n.start));
          if (n.type !== "CallExpression") return;
          const callee = n.callee.type === "Identifier" ? n.callee.name : n.callee.property?.name;
          if (n.callee.type === "MemberExpression" && n.callee.object?.name === "Date" && callee === "now") fn.dates.push(loc(n.start));
          if (n.callee.type === "Identifier" && callee === "fetch") fn.fetches.push(loc(n.start));
          if (callee === "run") fn.runs.push({ to: nameOf(n.arguments[0]), at: loc(n.start) });
          if (callee === "emit") fn.emits.push({ to: nameOf(n.arguments[0]), at: loc(n.start) });
        });
        fns.set(fn.id, fn);
      }
    }
  }
  return { modules, fns, imports };
}
