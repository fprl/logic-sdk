// Reads the app's source with a real parser (oxc): which functions run which, what they emit,
// what each file imports. No regex, and no code is executed here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseSync } from "oxc-parser";
import { ResolverFactory, type NapiResolveOptions } from "oxc-resolver";

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
  authorize?: string; // the policy as written (`authorize: member` → "member"), "inline", or undefined
  runs: Edge[];
  emits: Edge[];
  checks: string[]; // can*(...) record checks it calls, directly or through this module's helpers
  fetches: Loc[]; // fetch(...) calls
  dates: Loc[]; // new Date() / Date.now()
}
export interface SourceImport {
  from: string | null; // module that imports, or null for a file outside every module (a route, a page)
  spec: string;
  target: string; // module it reaches
  internal: boolean; // reaches a file other than the module's index
  index: string; // what to import instead: the module's index, written like `spec`
  at: Loc;
}
/** A record check (`can*`) that can't work: async, awaited, or its result thrown away. */
export interface CanIssue {
  code: "async-can" | "unused-can";
  name: string;
  how: "declared" | "awaited" | "discarded";
  at: Loc;
}
export interface Source {
  /** `folder: false`: the module is a single file (fine for small modules). */
  modules: Record<string, { dir: string; index: string; folder: boolean }>;
  fns: Map<string, SourceFn>;
  imports: SourceImport[];
  cans: CanIssue[];
}

type Node = { type: string; start: number; [key: string]: any };
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"]);
const unwrap = (n: Node | undefined): Node | undefined => (n && WRAPPERS.has(n.type) ? unwrap(n.expression) : n);
const isFunction = (n: Node | undefined) =>
  n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression" || n?.type === "FunctionDeclaration";
const CAN = /^can[A-Z]/;
/** `canCancel(...)` or `rules.canCancel(...)`: the called name. */
const calleeName = (call: Node): string | undefined =>
  call.callee?.type === "Identifier" ? call.callee.name : call.callee?.computed ? undefined : call.callee?.property?.name;

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const key in n) if (key !== "parent") walk(n[key], visit);
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);
/** Source files under `dir`. Skips dependencies, build output, dot folders (.next, .git) and tests. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) || name.startsWith(".") ? [] : sourceFiles(path);
    return /\.([mc]?ts|tsx|[mc]?js|jsx)$/.test(name) && !/\.(test|spec|d)\.[mc]?[jt]sx?$/.test(name) ? [path] : [];
  });
}

/** Every specifier a file loads: imports, re-exports, and `import("...")` with a string. */
function specifiers(program: Node): { spec: string; start: number; decl?: Node }[] {
  const found: { spec: string; start: number; decl?: Node }[] = [];
  for (const s of program.body)
    if (s.type === "ImportDeclaration") found.push({ spec: s.source.value, start: s.start, decl: s });
    else if ((s.type === "ExportNamedDeclaration" || s.type === "ExportAllDeclaration") && s.source)
      found.push({ spec: s.source.value, start: s.start });
  walk(program, (n) => {
    const src = n.type === "ImportExpression" ? n.source : undefined;
    if (src?.type === "Literal" && typeof src.value === "string") found.push({ spec: src.value, start: n.start });
  });
  return found;
}

export class ParseError extends Error {}

export function analyze(root: string, registryFile: string): Source {
  // tsconfig `paths` (found from each file, like tsc) and package.json `imports` (#alias) resolve like any import.
  // Without symlinks, so paths stay comparable with the folders we list.
  const options: NapiResolveOptions = {
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"],
    extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] },
    conditionNames: ["import", "module", "node", "default"],
    mainFiles: ["index"],
    symlinks: false,
  };
  const withTsconfig = new ResolverFactory({ ...options, tsconfig: "auto" });
  const plain = withTsconfig.cloneWithOptions(options); // when a tsconfig can't be read, still resolve the rest
  const resolve = (fromFile: string, spec: string) =>
    withTsconfig.resolveFileSync(fromFile, spec).path ?? plain.resolveFileSync(fromFile, spec).path;

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
    return { file, program: result.program as unknown as Node, loc };
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

  /** `import * as links from "<this>"`: the spec without the inner path when it ends with it, else a relative path. */
  const indexSpec = (spec: string, fromFile: string, resolved: string, target: string) => {
    const m = modules[target]!;
    const noExt = (p: string) => p.replace(/\.[mc]?[jt]sx?$/, "");
    const inner = noExt(relative(m.dir, resolved)).split(sep).join("/");
    for (const tail of [inner, inner.replace(/(^|\/)index$/, "")])
      if (tail && noExt(spec).endsWith("/" + tail)) {
        const candidate = noExt(spec).slice(0, -tail.length - 1);
        if (resolve(fromFile, candidate) === m.index) return candidate; // e.g. "#stock/*" has no "#stock"
      }
    const rel = noExt(relative(dirname(fromFile), m.folder ? m.dir : m.index)).split(sep).join("/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  };

  const fns = new Map<string, SourceFn>();
  const imports: SourceImport[] = [];
  const cans: CanIssue[] = [];

  /** Imports from `file` (in module `from`, or null) that land in another module. Returns where each local name points. */
  const scanImports = (file: string, program: Node, loc: (o: number) => Loc, from: string | null) => {
    const local: Record<string, { mod: string; ns: boolean }> = {};
    for (const { spec, start, decl } of specifiers(program)) {
      const resolved = resolve(file, spec);
      const target = resolved ? moduleOf(resolved) : undefined;
      if (!resolved || !target) continue;
      for (const sp of decl?.specifiers ?? []) local[sp.local.name] = { mod: target, ns: sp.type === "ImportNamespaceSpecifier" };
      if (target !== from)
        imports.push({
          from,
          spec,
          target,
          internal: resolved !== modules[target]!.index,
          index: indexSpec(spec, file, resolved, target),
          at: loc(start),
        });
    }
    return local;
  };

  type File = ReturnType<typeof read> & { nameOf: (arg: Node | undefined) => string };
  type Found = Pick<SourceFn, "runs" | "emits" | "checks">;

  /**
   * Where ctx is in `fns`: the parameter at `param`, or any parameter named ctx (helpers: `findBooking(ctx, id)`).
   * `run`/`emit` count only on it: `ctx.run(…)`, `ctx.with({…}).run(…)`, or destructured from it. Never `db.run(…)`.
   */
  const ctxIn = (fns: Node[], param: number | "any") => {
    const names = new Set(["ctx"]);
    const direct = new Map<string, "run" | "emit">(); // local name → what it is
    const fromPattern = (pattern: Node | undefined, isCtx: boolean) => {
      const p = pattern?.type === "AssignmentPattern" ? pattern.left : pattern;
      if (p?.type === "Identifier" && isCtx) names.add(p.name);
      if (p?.type === "ObjectPattern")
        for (const prop of p.properties) {
          const key = prop.key?.name;
          const value = prop.value?.type === "AssignmentPattern" ? prop.value.left : prop.value;
          if ((key === "run" || key === "emit") && value?.type === "Identifier") direct.set(value.name, key);
        }
    };
    for (const f of fns) (param === "any" ? f.params : [f.params[param]]).forEach((p: Node) => fromPattern(p, param !== "any"));
    walk(fns, (n) => {
      const init = n.type === "VariableDeclarator" ? unwrap(n.init) : undefined;
      if (n.id?.type === "ObjectPattern" && init?.type === "Identifier" && names.has(init.name)) fromPattern(n.id, false);
    });
    const onCtx = (n: Node | undefined): boolean => {
      const o = unwrap(n);
      if (o?.type === "Identifier") return names.has(o.name);
      return o?.type === "CallExpression" && o.callee?.type === "MemberExpression" && o.callee.property?.name === "with" && onCtx(o.callee.object);
    };
    return (call: Node): "run" | "emit" | undefined => {
      if (call.callee.type === "Identifier") return direct.get(call.callee.name);
      const prop = call.callee.type === "MemberExpression" && !call.callee.computed ? call.callee.property?.name : undefined;
      return (prop === "run" || prop === "emit") && onCtx(call.callee.object) ? prop : undefined;
    };
  };

  for (const [mod, { dir, folder, index }] of Object.entries(modules)) {
    const files: File[] = (folder ? sourceFiles(dir) : [index]).map((f) => {
      const file = read(f);
      const local = scanImports(f, file.program, file.loc, mod);
      const nameOf = (arg: Node | undefined): string => {
        if (arg?.type === "MemberExpression" && arg.object?.type === "Identifier" && local[arg.object.name]?.ns)
          return `${local[arg.object.name]!.mod}.${arg.property.name}`;
        if (arg?.type === "Identifier") return `${local[arg.name]?.mod ?? mod}.${arg.name}`;
        return "(dynamic)";
      };
      return { ...file, nameOf };
    });

    // Functions declared at the top level of this module's files: helpers like findBooking(ctx, id),
    // followed (transitively) for the runs, emits and record checks they make.
    const helpers = new Map<string, { node: Node; file: File }[]>();
    for (const file of files)
      for (const top of file.program.body) {
        const s = top.type === "ExportNamedDeclaration" || top.type === "ExportDefaultDeclaration" ? top.declaration : top;
        const add = (name: string, node: Node) => helpers.set(name, [...(helpers.get(name) ?? []), { node, file }]);
        if (s?.type === "FunctionDeclaration" && s.id) add(s.id.name, s);
        if (s?.type === "VariableDeclaration")
          for (const d of s.declarations) if (d.id?.type === "Identifier" && isFunction(unwrap(d.init))) add(d.id.name, unwrap(d.init)!);
      }
    const follow = (node: unknown, file: File, ctxCall: (n: Node) => "run" | "emit" | undefined, found: Found, seen: Set<Node>) =>
      walk(node, (n) => {
        if (n.type !== "CallExpression") return;
        const name = calleeName(n);
        const kind = ctxCall(n);
        if (kind === "run") found.runs.push({ to: file.nameOf(n.arguments[0]), at: file.loc(n.start) });
        else if (kind === "emit") found.emits.push({ to: file.nameOf(n.arguments[0]), at: file.loc(n.start) });
        else if (name && CAN.test(name)) {
          if (!found.checks.includes(name)) found.checks.push(name);
        } else if (name && n.callee.type === "Identifier")
          for (const h of helpers.get(name) ?? [])
            if (!seen.has(h.node)) follow(h.node.body, h.file, ctxIn([h.node], "any"), found, seen.add(h.node));
      });

    for (const file of files) {
      const { program, loc } = file;

      // Record checks must be sync and their result used
      walk(program, (n) => {
        const fnName =
          n.type === "FunctionDeclaration" ? n.id?.name
          : n.type === "VariableDeclarator" && isFunction(unwrap(n.init)) ? n.id?.name
          : (n.type === "Property" || n.type === "MethodDefinition") && isFunction(n.value) ? n.key?.name
          : undefined;
        const fnNode = n.type === "FunctionDeclaration" ? n : n.type === "VariableDeclarator" ? unwrap(n.init) : n.value;
        if (fnName && CAN.test(fnName) && fnNode?.async) cans.push({ code: "async-can", name: fnName, how: "declared", at: loc(n.start) });
        const awaited = n.type === "AwaitExpression" ? unwrap(n.argument) : undefined;
        if (awaited?.type === "CallExpression" && CAN.test(calleeName(awaited) ?? ""))
          cans.push({ code: "async-can", name: calleeName(awaited)!, how: "awaited", at: loc(n.start) });
        const discarded = n.type === "ExpressionStatement" ? unwrap(n.expression) : undefined;
        if (discarded?.type === "CallExpression" && CAN.test(calleeName(discarded) ?? ""))
          cans.push({ code: "unused-can", name: calleeName(discarded)!, how: "discarded", at: loc(n.start) });
      });

      for (const s of program.body) {
        const decl = s.type === "ExportNamedDeclaration" ? s.declaration?.declarations?.[0] : undefined;
        const call = unwrap(decl?.init);
        if (call?.type !== "CallExpression" || decl.id?.type !== "Identifier") continue;
        const fn: SourceFn = { id: `${mod}.${decl.id.name}`, at: loc(decl.start), runs: [], emits: [], checks: [], fetches: [], dates: [] };

        const def = call.arguments[0];
        const props: Node[] = def?.type === "ObjectExpression" ? def.properties : [];
        const authorize = props.find((p) => p.key?.name === "authorize")?.value;
        if (authorize)
          fn.authorize =
            authorize.type === "Identifier" ? authorize.name
            : authorize.type === "MemberExpression" && !authorize.computed && authorize.object?.type === "Identifier"
              ? `${authorize.object.name}.${authorize.property.name}`
              : "inline";

        walk(call.arguments, (n) => {
          if (n.type === "NewExpression" && n.callee?.name === "Date" && n.arguments.length === 0) fn.dates.push(loc(n.start));
          if (n.type !== "CallExpression") return;
          const callee = calleeName(n);
          if (n.callee.type === "MemberExpression" && n.callee.object?.name === "Date" && callee === "now") fn.dates.push(loc(n.start));
          if (n.callee.type === "Identifier" && callee === "fetch") fn.fetches.push(loc(n.start));
        });
        // ctx is the second parameter: `execute(input, ctx)` in a definition, `on(() => event, (payload, ctx) => …)` in a listener
        const handlers = [...props.filter((p) => p.key?.name === "execute").map((p) => p.value), ...call.arguments.slice(1)].filter(isFunction);
        follow(call.arguments, file, ctxIn(handlers, 1), fn, new Set());
        fns.set(fn.id, fn);
      }
    }
  }

  // Everything else under the registry's folder (routes, pages, scripts) reaches modules only through their index.
  for (const file of sourceFiles(dirname(registryFile)))
    if (!moduleOf(file)) {
      const { program, loc } = read(file);
      scanImports(file, program, loc, null);
    }

  return { modules, fns, imports, cans };
}
