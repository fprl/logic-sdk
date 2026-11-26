// Reads the app's source with a real parser (oxc): which functions run, emit and schedule which, the config keys and
// record checks they use. No regex, and no code is executed here.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
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
  scope?: string[]; // scope keys this run changes: ctx.run(fn, input, { scope: { actor } }) → ["actor"]
}
/** What a handler's ctx calls: `ctx.run`, `ctx.emit` and `ctx.schedule`, or the same names destructured from ctx. */
const CALLS = ["run", "emit", "schedule"] as const;
type Call = (typeof CALLS)[number];
/** A `const name = …(…)` a module exports, wherever it's declared. Matched against the registry by module and export, so definer names don't matter. */
export interface SourceFn {
  key: string; // `<module>.<export>`: the id can differ
  at: Loc;
  authorize?: string; // the policy as written (`authorize: member` → "member"), "inline", or undefined
  runs: Edge[];
  emits: Edge[];
  schedules: Edge[];
  checks: string[]; // can*(...) record checks it calls, directly or through this module's helpers
  config: string[]; // ctx.config keys it reads ("orders.maxItems"), directly or through this module's helpers
  doc?: string; // the first paragraph of the JSDoc block above the export, shown by list and show
}
const KINDS = ["query", "mutation", "action", "listener", "cron", "event"] as const;
/** What `init()` from "logic-sdk" defines: a definer's kind is the key it was destructured as. */
export type DefinerKind = (typeof KINDS)[number];
type FnKind = "query" | "mutation" | "action";
/**
 * A query, mutation or action in a module's files that its index doesn't export: `ctx.run` runs it as part of the
 * module that runs it. `key` is the runtime's name for it (`files.(private)`, or `files.<id>`) plus its variable name.
 */
export interface PrivateFn extends SourceFn {
  module: string;
  name: string; // its variable name
  kind: FnKind;
  takesInput: boolean;
  declaresOutput: boolean;
}
/** What the registry never sees, so it never runs: a listener, cron or event no index exports, or anything in a file no module reaches. */
export interface Unregistered {
  module: string | null; // null: in no module's folder
  name: string;
  kind: DefinerKind;
  at: Loc;
  doc?: string;
}
export interface Source {
  /** Each module's entry: the file the registry imports it from. Its files are whatever that entry reaches. */
  modules: Record<string, { entry: string }>;
  fns: Map<string, SourceFn>;
  privates: PrivateFn[];
  unregistered: Unregistered[];
}

type Node = { type: string; start: number; [key: string]: any };
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"]);
const unwrap = (n: Node | undefined): Node | undefined => (n && WRAPPERS.has(n.type) ? unwrap(n.expression) : n);
const isFunction = (n: Node | undefined): n is Node =>
  n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression" || n?.type === "FunctionDeclaration";
const CAN = /^can[A-Z]/;
/** `canCancel(...)` or `rules.canCancel(...)`: the called name. */
const calleeName = (call: Node): string | undefined =>
  call.callee?.type === "Identifier" ? call.callee.name : call.callee?.computed ? undefined : call.callee?.property?.name;

/** An identifier or a string name: `export { a as "b" }`. */
const idName = (n: Node): string => n.name ?? n.value;
/** The names a declarator binds: `a`, or `query` and `m` in `{ query, mutation: m }`. */
const boundNames = (id: Node | undefined): string[] =>
  id?.type === "Identifier" ? [id.name]
  : id?.type === "ObjectPattern" ? id.properties.flatMap((p: Node) => (p.value?.type === "Identifier" ? [p.value.name] : []))
  : [];
/** The names a declaration binds: `export const a = …, b = …`, `export const { query } = init()`, `export function c() {}`. Types bind none we need. */
const declaredNames = (d: Node | null | undefined): string[] =>
  d?.type === "VariableDeclaration" ? d.declarations.flatMap((v: Node) => boundNames(v.id))
  : (d?.type === "FunctionDeclaration" || d?.type === "ClassDeclaration") && d.id ? [d.id.name]
  : [];
/** Every top-level `const` declarator, exported or not, with its statement (where its JSDoc sits). */
const topConsts = (program: Node): { statement: Node; d: Node }[] =>
  program.body.flatMap((top: Node) => {
    const s = top.type === "ExportNamedDeclaration" ? top.declaration : top;
    return s?.type === "VariableDeclaration" ? s.declarations.map((d: Node) => ({ statement: top, d })) : [];
  });

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const key in n) if (key !== "parent") walk(n[key], visit);
}

const SOURCE = /\.([mc]?ts|tsx|[mc]?js|jsx)$/;

export class ParseError extends Error {}

/**
 * Where ctx is in `fns`: the parameter at `param`, or any parameter named ctx (helpers: `findBooking(ctx, id)`).
 * `run`/`emit`/`schedule` count only on it: `ctx.run(…)`, or destructured from it. Never `db.run(…)`.
 */
const ctxIn = (fns: Node[], param: number | "any") => {
  const names = new Set(["ctx"]);
  const direct = new Map<string, Call>(); // local name → what it is
  const configNames = new Map<string, string>(); // local name → the config path it holds ("" = all of config)
  const configKeys: string[] = []; // keys read by destructuring: `{ config: { orders } }`, `const { maxItems } = ctx.config.orders`
  const keyPath = (a: string, b: string) => (a ? `${a}.${b}` : b);
  /** `{ orders, app: { url } }` taken from the config path `prefix`: each leaf is a key read, each name an alias. */
  const fromConfigPattern = (pattern: Node, prefix: string) => {
    for (const prop of pattern.properties ?? []) {
      const key = prop.key?.name;
      const value = prop.value?.type === "AssignmentPattern" ? prop.value.left : prop.value;
      if (!key) {
        if (prop.type === "RestElement" && prop.argument?.type === "Identifier") configNames.set(prop.argument.name, prefix);
        continue;
      }
      if (value?.type === "ObjectPattern") fromConfigPattern(value, keyPath(prefix, key));
      else {
        configKeys.push(keyPath(prefix, key));
        if (value?.type === "Identifier") configNames.set(value.name, keyPath(prefix, key));
      }
    }
  };
  const fromPattern = (pattern: Node | undefined, isCtx: boolean) => {
    const p = pattern?.type === "AssignmentPattern" ? pattern.left : pattern;
    if (p?.type === "Identifier" && isCtx) names.add(p.name);
    if (p?.type === "ObjectPattern")
      for (const prop of p.properties) {
        const key = prop.key?.name;
        const value = prop.value?.type === "AssignmentPattern" ? prop.value.left : prop.value;
        if (CALLS.includes(key) && value?.type === "Identifier") direct.set(value.name, key);
        if (key === "config" && value?.type === "Identifier") configNames.set(value.name, "");
        if (key === "config" && value?.type === "ObjectPattern") fromConfigPattern(value, "");
      }
  };
  for (const f of fns) (param === "any" ? f.params : [f.params[param]]).forEach((p: Node) => fromPattern(p, param !== "any"));
  const onCtx = (n: Node | undefined): boolean => {
    const o = unwrap(n);
    return o?.type === "Identifier" && names.has(o.name);
  };
  const kindOf = (call: Node): Call | undefined => {
    if (call.callee.type === "Identifier") return direct.get(call.callee.name);
    const prop = call.callee.type === "MemberExpression" && !call.callee.computed ? call.callee.property?.name : undefined;
    return CALLS.includes(prop) && onCtx(call.callee.object) ? prop : undefined;
  };
  /**
   * The config path an expression holds: `ctx.config.orders.maxItems` or `config.orders.maxItems` → "orders.maxItems",
   * `ctx.config` → "" (all of it). `callee`: it's being called, so its last name is a method (`url.startsWith`), not a key.
   */
  const configPath = (expr: Node | undefined, callee = false): string | undefined => {
    const path: string[] = [];
    let cur = unwrap(expr);
    while (cur?.type === "MemberExpression" && !cur.computed) {
      path.unshift(cur.property.name);
      cur = unwrap(cur.object);
    }
    if (callee || path.at(-1) === "length") path.pop();
    const held = cur?.type === "Identifier" ? configNames.get(cur.name) : undefined;
    if (held !== undefined) return path.reduce(keyPath, held);
    if (path[0] === "config" && onCtx(cur)) return path.slice(1).join(".");
    return undefined;
  };
  // aliases, in source order: `const { run, config } = ctx`, `const c = ctx.config`, `const { maxItems } = c.orders`
  walk(fns, (n) => {
    if (n.type !== "VariableDeclarator") return;
    const init = unwrap(n.init);
    if (n.id?.type === "ObjectPattern" && init?.type === "Identifier" && names.has(init.name)) return fromPattern(n.id, false);
    const held = configPath(init);
    if (held === undefined) return;
    if (n.id?.type === "Identifier") configNames.set(n.id.name, held);
    if (n.id?.type === "ObjectPattern") fromConfigPattern(n.id, held);
  });
  return { kindOf, configPath, configKeys };
};

export function analyze(projectRoot: string, registryPath: string): Source {
  // Real paths, as Node and TypeScript resolve: a workspace package linked into node_modules is its own source
  // (`packages/logic/src/…`), and a real dependency stays under node_modules, which appFile skips.
  const root = realpathSync(projectRoot);
  const registryFile = realpathSync(registryPath);
  const reader = createReader(root);
  const modules = registryModules(reader, root, registryFile);
  const graph = moduleGraph(reader);
  const { prepared, privateIds, unregistered } = collectDefinitions(modules, graph);
  const { fns, privates } = followHandlers(prepared, privateIds);
  const reached = new Set(prepared.flatMap((m) => [...m.files.keys()]));
  return { modules, fns, privates, unregistered: [...unregistered, ...unreachedDefinitions(registryFile, modules, reached, reader.read, graph)] };
}

// ── Reading files ────────────────────────────────────────────────────────────

/** Resolves an import the way the app's tooling does, and parses each file once. */
function createReader(root: string) {
  // tsconfig `paths` (found from each file, like tsc) and package.json `imports` (#alias) resolve like any import.
  const options: NapiResolveOptions = {
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"],
    extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] },
    conditionNames: ["import", "module", "node", "default"],
    mainFiles: ["index"],
  };
  const withTsconfig = new ResolverFactory({ ...options, tsconfig: "auto" });
  const plain = withTsconfig.cloneWithOptions(options); // when a tsconfig can't be read, still resolve the rest
  const resolve = (fromFile: string, spec: string) =>
    withTsconfig.resolveFileSync(fromFile, spec).path ?? plain.resolveFileSync(fromFile, spec).path;

  const parsed = new Map<string, Parsed>();
  const read = (file: string): Parsed => {
    let r = parsed.get(file);
    if (!r) parsed.set(file, (r = parseFile(root, file)));
    return r;
  };
  return { resolve, read };
}
type Reader = ReturnType<typeof createReader>;
type Read = Reader["read"];
type Parsed = ReturnType<typeof parseFile>;

/** A file's AST, with where an offset is (relative to the project root) and the JSDoc above it. */
function parseFile(root: string, file: string) {
  const text = readFileSync(file, "utf8");
  const result = parseSync(file, text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const loc = (offset: number): Loc => {
    let line = lineStarts.findIndex((start) => start > offset);
    if (line === -1) line = lineStarts.length;
    return { file: relative(root, file), line, column: offset - lineStarts[line - 1]! + 1 };
  };
  /** The `/** … *\/` block right above `start` (only whitespace between): its first paragraph, on one line. */
  const docAt = (start: number) => {
    const c = result.comments.findLast((c) => c.end <= start);
    if (!c || c.type !== "Block" || !c.value.startsWith("*") || text.slice(c.end, start).trim()) return undefined;
    const lines = c.value.slice(1).split("\n").map((l) => l.replace(/^\s*\*?\s?/, "").trim());
    const body = lines.slice(lines.findIndex(Boolean)); // drop leading blank lines
    const end = body.findIndex((l) => l === "" || l.startsWith("@")); // a blank line or a tag ends the paragraph
    return body.slice(0, end === -1 ? undefined : end).join(" ") || undefined;
  };
  return { file, program: result.program as unknown as Node, loc, docAt };
}

// ── The registry ─────────────────────────────────────────────────────────────

/** registry.ts: `import * as bookings from "./bookings"` + `modules: { bookings, ... }`. */
function registryModules({ read, resolve }: Reader, root: string, registryFile: string): Source["modules"] {
  const reg = read(registryFile);
  const namespaces: Record<string, string> = {};
  for (const s of reg.program.body)
    if (s.type === "ImportDeclaration" && s.specifiers[0]?.type === "ImportNamespaceSpecifier") {
      const entry = resolve(registryFile, s.source.value);
      if (entry) namespaces[s.specifiers[0].local.name] = entry;
    }
  const modules: Source["modules"] = {};
  walk(reg.program, (n) => {
    if (n.type !== "Property" || n.key?.name !== "modules" || n.value?.type !== "ObjectExpression") return;
    for (const p of n.value.properties) {
      const entry = p.value?.type === "Identifier" ? namespaces[p.value.name] : undefined;
      if (p.key?.name && entry) modules[p.key.name] = { entry };
    }
  });
  if (!Object.keys(modules).length)
    throw new ParseError(
      `Couldn't find the modules in ${relative(root, registryFile)}. Expected createRegistry({ modules: { bookings, ... } }) with each module imported as \`import * as bookings from "./bookings"\`.`,
    );
  return modules;
}

// ── Exports ──────────────────────────────────────────────────────────────────
// A module is what its entry exports, followed through re-exports and imports to where each name is declared,
// the way the registry sees it. So any layout works: one file, a folder, `orders.ts` beside `orders/`, renames.

/** Where an export is declared: the file, and its name there. */
type Decl = { file: string; local: string };
const declKey = (d: Decl) => `${d.file}#${d.local}`;

/** The app's imports and exports, traced to declarations, and which definer made a call. */
function moduleGraph({ read, resolve }: Reader) {
  /** An import that points into the app (not a dependency or a .d.ts), as a file we can parse. */
  const appFile = (fromFile: string, spec: string) => {
    const f = resolve(fromFile, spec);
    return f && SOURCE.test(f) && !/\.d\.[mc]?ts$/.test(f) && !f.split(sep).includes("node_modules") ? f : undefined;
  };
  const importCache = new Map<string, Map<string, { from: string; name: string }>>();
  /** What `file` imports from the app, by local name: the file, and the export it names ("*" for a namespace). */
  const importsOf = (file: string) => {
    let out = importCache.get(file);
    if (out) return out;
    importCache.set(file, (out = new Map()));
    for (const s of read(file).program.body) {
      if (s.type !== "ImportDeclaration" || s.importKind === "type") continue;
      const from = appFile(file, s.source.value);
      if (from)
        for (const sp of s.specifiers)
          out.set(sp.local.name, {
            from,
            name: sp.type === "ImportNamespaceSpecifier" ? "*" : sp.type === "ImportDefaultSpecifier" ? "default" : idName(sp.imported),
          });
    }
    return out;
  };
  const exportCache = new Map<string, Map<string, Decl>>();
  /** `name` as `file` sees it: declared there, or imported from another file. */
  const declOf = (file: string, name: string): Decl | undefined => {
    const imp = importsOf(file).get(name);
    return !imp ? { file, local: name } : imp.name === "*" ? undefined : exportsOf(imp.from).get(imp.name);
  };
  /** Every name `file` exports, traced to where it's declared. */
  const exportsOf = (file: string): Map<string, Decl> => {
    let out = exportCache.get(file);
    if (out) return out;
    exportCache.set(file, (out = new Map())); // set before reading: a cycle of re-exports stops here
    for (const s of read(file).program.body) {
      if (s.exportKind === "type") continue;
      if (s.type === "ExportNamedDeclaration") {
        const from = s.source ? appFile(file, s.source.value) : undefined;
        if (s.source && !from) continue;
        for (const name of declaredNames(s.declaration)) out.set(name, { file, local: name });
        for (const sp of s.specifiers) {
          if (sp.exportKind === "type") continue;
          const decl = from ? exportsOf(from).get(idName(sp.local)) : declOf(file, idName(sp.local));
          if (decl) out.set(idName(sp.exported), decl);
        }
      }
      if (s.type === "ExportAllDeclaration" && !s.exported) {
        const from = appFile(file, s.source.value);
        if (from) for (const [name, decl] of exportsOf(from)) if (name !== "default" && !out.has(name)) out.set(name, decl);
      }
    }
    return out;
  };
  /** The kind of a call's definer, when it's one from `init()`. */
  const kindOfCall = (path: string, call: Node) => (call.callee.type === "Identifier" ? definerKind(read, declOf(path, call.callee.name)) : undefined);
  return { read, importsOf, declOf, exportsOf, kindOfCall };
}
type ModuleGraph = ReturnType<typeof moduleGraph>;

/** The kind of the definer `decl` names: the key it was destructured as from `init()` of "logic-sdk", so aliases work. */
function definerKind(read: Read, decl: Decl | undefined): DefinerKind | undefined {
  if (!decl) return undefined;
  const { program } = read(decl.file);
  const init = program.body
    .filter((s: Node) => s.type === "ImportDeclaration" && s.source.value === "logic-sdk")
    .flatMap((s: Node) => s.specifiers)
    .find((sp: Node) => sp.type === "ImportSpecifier" && idName(sp.imported) === "init")?.local.name;
  if (!init) return undefined;
  for (const { d } of topConsts(program)) {
    const call = unwrap(d.init);
    if (d.id?.type !== "ObjectPattern" || call?.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== init) continue;
    const key = d.id.properties.find((p: Node) => p.value?.type === "Identifier" && p.value.name === decl.local)?.key;
    const kind = key && KINDS.find((k) => k === idName(key));
    if (kind) return kind;
  }
  return undefined;
}

// ── Definitions ──────────────────────────────────────────────────────────────

/** A definer call's options: `{ input, authorize, handler, … }`. */
const propsOf = (call: Node): Node[] => (call.arguments[0]?.type === "ObjectExpression" ? call.arguments[0].properties : []);
/** Each top-level `const x = …(…)` in a file. */
const definitionsIn = (program: Node): { statement: Node; d: Node; call: Node }[] =>
  topConsts(program).flatMap(({ statement, d }) => {
    const call = unwrap(d.init);
    return d.id?.type === "Identifier" && call?.type === "CallExpression" ? [{ statement, d, call }] : [];
  });

type File = Parsed & { nameOf: (arg: Node | undefined) => string };
type Found = Pick<SourceFn, "runs" | "emits" | "schedules" | "checks" | "config">;
/** A `const x = definer({…})` in a module's files: exported from its entry under `names`, or private. */
type Def = { file: File; statement: Node; d: Node; call: Node; names: string[]; private?: FnKind };
/** A module's files, and the definitions in them its handlers get followed from. */
type ModuleDefs = { mod: string; files: Map<string, File>; defs: Def[] };
/** A private function → its `id`, or undefined. Its name depends on the module that runs it, as at runtime. */
type PrivateIds = Map<string, string | undefined>;
const privateName = (privateIds: PrivateIds, mod: string, decl: Decl) => `${mod}.${privateIds.get(declKey(decl)) ?? `(private) ${decl.local}`}`;

/**
 * Every module's files and definitions, before any handler is followed, so a run of any private function resolves.
 * Also what a module's files define that its index doesn't export, besides functions: it never runs.
 */
function collectDefinitions(modules: Source["modules"], graph: ModuleGraph) {
  const { read, importsOf, declOf, exportsOf, kindOfCall } = graph;
  const publicName = new Map<string, string>(); // a declaration → "<module>.<export>", the name the registry gives it
  const owner = new Map<string, string>(); // a file → the module it belongs to: its entry, or where its exports are declared
  for (const [mod, { entry }] of Object.entries(modules)) owner.set(entry, mod);
  for (const [mod, { entry }] of Object.entries(modules)) {
    for (const [name, d] of exportsOf(entry)) {
      if (!publicName.has(declKey(d))) publicName.set(declKey(d), `${mod}.${name}`);
      if (!owner.has(d.file)) owner.set(d.file, mod);
    }
  }

  const privateIds: PrivateIds = new Map();
  const unregistered: Unregistered[] = [];
  const listed = new Set<string>(); // unregistered declarations already listed: a file two modules import is in both
  const prepared = Object.entries(modules).map(([mod, { entry }]): ModuleDefs => {
    // Its files: where its exports are declared, plus what those import that no other module owns (helpers, shared code).
    const exported = new Map<string, string[]>(); // a declaration → its export names
    for (const [name, d] of exportsOf(entry)) exported.set(declKey(d), [...(exported.get(declKey(d)) ?? []), name]);
    const paths = new Set([entry, ...[...exportsOf(entry).values()].map((d) => d.file)]);
    for (const path of paths)
      for (const { from } of importsOf(path).values()) if ((owner.get(from) ?? mod) === mod) paths.add(from);
    /** The function a declaration is, as this module names it: `stock.hold`, `files.(private) record`, or "(dynamic)". */
    const named = (decl: Decl | undefined) =>
      !decl ? "(dynamic)" : (publicName.get(declKey(decl)) ?? (privateIds.has(declKey(decl)) ? privateName(privateIds, mod, decl) : "(dynamic)"));
    const files = new Map<string, File>();
    const defs: Def[] = [];
    for (const path of paths) {
      /** The function a `run`/`emit`/`schedule` argument names: `stock.hold`, `hold`, or "(dynamic)". */
      const nameOf = (arg: Node | undefined): string => {
        if (arg?.type === "MemberExpression" && !arg.computed && arg.object?.type === "Identifier") {
          const imp = importsOf(path).get(arg.object.name);
          return named(imp?.name === "*" ? exportsOf(imp.from).get(arg.property.name) : undefined);
        }
        return arg?.type === "Identifier" ? named(declOf(path, arg.name)) : "(dynamic)";
      };
      const file = { ...read(path), nameOf };
      files.set(path, file);

      for (const { statement, d, call } of definitionsIn(file.program)) {
        const decl = { file: path, local: d.id.name };
        const names = exported.get(declKey(decl)) ?? [];
        // exported: matched to the registry by name, whatever made it. The rest of this module's files: what a definer made
        if (names.length) {
          defs.push({ file, statement, d, call, names });
          continue;
        }
        if ((owner.get(path) ?? mod) !== mod) continue;
        const kind = kindOfCall(path, call);
        if (kind === "query" || kind === "mutation" || kind === "action") {
          const id = propsOf(call).find((p) => p.key?.name === "id")?.value;
          privateIds.set(declKey(decl), id?.type === "Literal" && typeof id.value === "string" ? id.value : undefined);
          defs.push({ file, statement, d, call, names, private: kind });
        } else if (kind && !listed.has(declKey(decl))) {
          listed.add(declKey(decl));
          unregistered.push({ module: mod, name: d.id.name, kind, at: file.loc(d.start), doc: file.docAt(statement.start) });
        }
      }
    }
    return { mod, files, defs };
  });
  return { prepared, privateIds, unregistered };
}

// ── Following handlers ───────────────────────────────────────────────────────

/** What each definition's handler runs, emits and schedules, and the checks and config it uses, through its helpers. */
function followHandlers(prepared: ModuleDefs[], privateIds: PrivateIds) {
  const fns = new Map<string, SourceFn>();
  const privates: PrivateFn[] = [];
  for (const { mod, files, defs } of prepared) {
    const helpers = helpersIn(files);
    for (const def of defs) {
      const { file, statement, d, call } = def;
      const found: Omit<SourceFn, "key"> = { at: file.loc(d.start), runs: [], emits: [], schedules: [], checks: [], config: [], doc: file.docAt(statement.start) };
      const props = propsOf(call);
      const authorize = props.find((p) => p.key?.name === "authorize")?.value;
      if (authorize)
        found.authorize =
          authorize.type === "Identifier" ? authorize.name
          : authorize.type === "MemberExpression" && !authorize.computed && authorize.object?.type === "Identifier"
            ? `${authorize.object.name}.${authorize.property.name}`
            : "inline";

      // ctx is the first parameter: `handler(ctx, input)` in a function, `handler(ctx, payload)` in a listener
      const handlers = props.filter((p) => p.key?.name === "handler").map((p) => p.value).filter(isFunction);
      follow(helpers, call.arguments, file, ctxIn(handlers, 0), found, new Set());
      // keep the most specific keys: `orders.maxItems`, not also `orders`
      found.config = found.config.includes("*") ? ["*"] : found.config.filter((k) => !found.config.some((o) => o.startsWith(k + "."))).sort();
      for (const name of def.names) fns.set(`${mod}.${name}`, { ...found, key: `${mod}.${name}` });
      if (def.private)
        privates.push({
          ...found,
          key: privateName(privateIds, mod, { file: file.file, local: d.id.name }),
          module: mod,
          name: d.id.name,
          kind: def.private,
          takesInput: props.some((p) => p.key?.name === "input"),
          declaresOutput: props.some((p) => p.key?.name === "output"),
        });
    }
  }
  return { fns, privates };
}

type Helpers = Map<string, { node: Node; file: File }[]>;
/**
 * Functions declared at the top level of a module's files: helpers like findBooking(ctx, id),
 * followed (transitively) for the runs, emits, schedules and record checks they make.
 */
function helpersIn(files: Map<string, File>): Helpers {
  const helpers: Helpers = new Map();
  for (const file of files.values())
    for (const top of file.program.body) {
      const s = top.type === "ExportNamedDeclaration" || top.type === "ExportDefaultDeclaration" ? top.declaration : top;
      const add = (name: string, node: Node) => helpers.set(name, [...(helpers.get(name) ?? []), { node, file }]);
      if (s?.type === "FunctionDeclaration" && s.id) add(s.id.name, s);
      if (s?.type === "VariableDeclaration")
        for (const d of s.declarations) {
          const fn = unwrap(d.init);
          if (d.id?.type === "Identifier" && isFunction(fn)) add(d.id.name, fn);
        }
    }
  return helpers;
}

/**
 * `{ scope: { ...ctx.scope, actor: system } }` in run options → the keys it changes; "(dynamic)" when they can't
 * be read. Spreading the caller's own scope (`...ctx.scope`, `...scope`) changes nothing, so it isn't listed.
 */
const ownScope = (n: Node | undefined) =>
  (n?.type === "Identifier" && n.name === "scope") || (n?.type === "MemberExpression" && n.property?.name === "scope");
const scopeOf = (options: Node | undefined): { scope?: string[] } => {
  const o = unwrap(options);
  if (!o) return {};
  if (o.type !== "ObjectExpression") return { scope: ["(dynamic)"] };
  const prop = o.properties.find((p: Node) => p.key?.name === "scope");
  if (!prop) return {};
  const value = unwrap(prop.value);
  if (value?.type !== "ObjectExpression") return { scope: ["(dynamic)"] };
  return {
    scope: value.properties
      .filter((p: Node) => !(p.type === "SpreadElement" && ownScope(unwrap(p.argument))))
      .map((p: Node) => p.key?.name ?? p.key?.value ?? "(dynamic)"),
  };
};
const readConfig = (found: Found, key: string | undefined) => {
  if (key === undefined) return;
  const k = key || "*"; // "*": all of it escaped (passed on whole), so any key may be read
  if (!found.config.includes(k)) found.config.push(k);
};

/** Walks `node` for what ctx does, into `found`, and into each helper it calls (once: `seen`). */
function follow(helpers: Helpers, node: unknown, file: File, ctx: ReturnType<typeof ctxIn>, found: Found, seen: Set<Node>): void {
  for (const k of ctx.configKeys) readConfig(found, k);
  const callees = new Set<Node>();
  walk(node, (n) => {
    if (n.type === "MemberExpression") {
      const key = ctx.configPath(n, callees.has(n));
      if (key) readConfig(found, key); // "" here is `ctx.config` itself, the start of a longer path
    }
    if (n.type !== "CallExpression") return;
    if (n.callee.type === "MemberExpression") callees.add(n.callee); // walked after its call: see the method
    for (const arg of n.arguments) {
      const key = ctx.configPath(arg);
      // handed on: a destructured setting, or all of config. A longer path is read as a member expression
      if (arg.type === "Identifier" || key === "") readConfig(found, key);
    }
    const name = calleeName(n);
    const kind = ctx.kindOf(n);
    if (kind === "run") found.runs.push({ to: file.nameOf(n.arguments[0]), at: file.loc(n.start), ...scopeOf(n.arguments[2]) });
    else if (kind === "emit") found.emits.push({ to: file.nameOf(n.arguments[0]), at: file.loc(n.start) });
    else if (kind === "schedule") found.schedules.push({ to: file.nameOf(n.arguments[0]), at: file.loc(n.start) });
    else if (name && CAN.test(name)) {
      if (!found.checks.includes(name)) found.checks.push(name);
    } else if (name && n.callee.type === "Identifier")
      for (const h of helpers.get(name) ?? []) {
        if (seen.has(h.node)) continue;
        seen.add(h.node);
        follow(helpers, h.node.body, h.file, ctxIn([h.node], "any"), found, seen);
      }
  });
}

// ── Unreached files ──────────────────────────────────────────────────────────

/**
 * Definitions in files no module reaches, in the registry's folder and each module's: a forgotten
 * `export * from "./listeners"`. Like Trigger.dev's `dirs`, without tests: what they define is never registered on
 * purpose. A symlinked file is read where it really lives, and with a TypeScript registry, `.js` files are build output.
 */
function unreachedDefinitions(registryFile: string, modules: Source["modules"], reached: Set<string>, read: Read, { kindOfCall }: ModuleGraph): Unregistered[] {
  const unregistered: Unregistered[] = [];
  const folderOf = (entry: string) => (/^index\.[^.]+$/.test(basename(entry)) ? dirname(entry) : entry.replace(/\.[^./]+$/, ""));
  // nearest first: a module nested in another's folder takes its own files
  const folders = Object.entries(modules)
    .map(([mod, { entry }]) => ({ mod, folder: folderOf(entry) + sep }))
    .sort((a, b) => b.folder.length - a.folder.length);
  const skipped = /\.[mc]?tsx?$/.test(registryFile) ? /\.(test|spec)\.|\.d\.[mc]?ts$|\.[mc]?jsx?$/ : /\.(test|spec)\.|\.d\.[mc]?ts$/;
  const roots = [dirname(registryFile), ...Object.values(modules).map((m) => dirname(m.entry))]
    .filter((dir, i, all) => all.indexOf(dir) === i && !all.some((other) => dir.startsWith(other + sep)));
  const scan = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) scan(path);
      if (!e.isFile() || !SOURCE.test(e.name) || skipped.test(e.name) || reached.has(path)) continue;
      const file = read(path);
      for (const { statement, d, call } of definitionsIn(file.program)) {
        const kind = kindOfCall(path, call);
        if (kind)
          unregistered.push({ module: folders.find((f) => path.startsWith(f.folder))?.mod ?? null, name: d.id.name, kind, at: file.loc(d.start), doc: file.docAt(statement.start) });
      }
    }
  };
  for (const dir of roots) scan(dir);
  return unregistered;
}
