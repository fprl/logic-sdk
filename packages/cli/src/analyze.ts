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
  scope?: string[]; // scope keys this run changes: ctx.run(fn, input, { scope: { actor } }) → ["actor"]
}
/** An `export const name = …(…)` in a module file. Matched against the registry by module and export, so definer names don't matter. */
export interface SourceFn {
  key: string; // `<module>.<export>`: the id can differ
  at: Loc;
  authorize?: string; // the policy as written (`authorize: member` → "member"), "inline", or undefined
  runs: Edge[];
  emits: Edge[];
  checks: string[]; // can*(...) record checks it calls, directly or through this module's helpers
  config: string[]; // ctx.config keys it reads ("orders.maxItems"), directly or through this module's helpers
  fetches: Loc[]; // fetch(...) calls
  dates: Loc[]; // new Date() / Date.now()
  doc?: string; // the first paragraph of the JSDoc block above the export, shown by list and show
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
/** Something a module file does, itself or through a file it imports (`../lib/urls.ts` → `env.ts`): reading env, say. */
export interface Reached {
  module: string;
  what: string; // "process.env", ".transaction()", `drizzle() from "drizzle-orm/pglite"`
  at: Loc; // in the module file: the thing itself, or the import that leads to it
  via?: Loc; // where it actually is, when it's in an imported file
}
export interface Source {
  /** `folder: false`: the module is a single file (fine for small modules). */
  modules: Record<string, { dir: string; index: string; folder: boolean }>;
  fns: Map<string, SourceFn>;
  imports: SourceImport[];
  cans: CanIssue[];
  env: Reached[];
  /** `x.transaction(...)` calls: a savepoint inside a mutation, which events made in it would escape. */
  transactions: Reached[];
  /** Database clients created (`drizzle(...)`): a module using one writes outside the mutation's transaction. */
  dbClients: Reached[];
}

type Node = { type: string; start: number; [key: string]: any };
/** One thing found in one file, before it's tied to a module. */
type Hit = Pick<Reached, "what" | "at">;
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"]);
const unwrap = (n: Node | undefined): Node | undefined => (n && WRAPPERS.has(n.type) ? unwrap(n.expression) : n);
const isFunction = (n: Node | undefined): n is Node =>
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

/** Type-only: `import type`, `import { type A }`, `export type … from`. Erased at runtime, so it loads no code. */
const typeOnly = (s: Node) =>
  s.importKind === "type" ||
  s.exportKind === "type" ||
  (s.specifiers?.length > 0 && s.specifiers.every((sp: Node) => sp.importKind === "type" || sp.exportKind === "type"));

/** Every specifier a file loads: imports, re-exports, and `import("...")` with a string. `values`: skip type-only ones. */
function specifiers(program: Node, values = false): { spec: string; start: number; decl?: Node }[] {
  const found: { spec: string; start: number; decl?: Node }[] = [];
  for (const s of program.body) {
    if (values && typeOnly(s)) continue;
    if (s.type === "ImportDeclaration") found.push({ spec: s.source.value, start: s.start, decl: s });
    if ((s.type === "ExportNamedDeclaration" || s.type === "ExportAllDeclaration") && s.source)
      found.push({ spec: s.source.value, start: s.start });
  }
  walk(program, (n) => {
    const src = n.type === "ImportExpression" ? n.source : undefined;
    if (src?.type === "Literal" && typeof src.value === "string") found.push({ spec: src.value, start: n.start });
  });
  return found;
}

export class ParseError extends Error {}

/**
 * Where ctx is in `fns`: the parameter at `param`, or any parameter named ctx (helpers: `findBooking(ctx, id)`).
 * `run`/`emit` count only on it: `ctx.run(…)`, or destructured from it. Never `db.run(…)`.
 */
const ctxIn = (fns: Node[], param: number | "any") => {
  const names = new Set(["ctx"]);
  const direct = new Map<string, "run" | "emit">(); // local name → what it is
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
        if ((key === "run" || key === "emit") && value?.type === "Identifier") direct.set(value.name, key);
        if (key === "config" && value?.type === "Identifier") configNames.set(value.name, "");
        if (key === "config" && value?.type === "ObjectPattern") fromConfigPattern(value, "");
      }
  };
  for (const f of fns) (param === "any" ? f.params : [f.params[param]]).forEach((p: Node) => fromPattern(p, param !== "any"));
  const onCtx = (n: Node | undefined): boolean => {
    const o = unwrap(n);
    return o?.type === "Identifier" && names.has(o.name);
  };
  const kindOf = (call: Node): "run" | "emit" | undefined => {
    if (call.callee.type === "Identifier") return direct.get(call.callee.name);
    const prop = call.callee.type === "MemberExpression" && !call.callee.computed ? call.callee.property?.name : undefined;
    return (prop === "run" || prop === "emit") && onCtx(call.callee.object) ? prop : undefined;
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

const ENV_PACKAGES = new Set(["process", "node:process"]);
const directEnv = (program: Node, loc: (o: number) => Loc): Hit[] => {
  const found: Hit[] = [];
  const cf = new Set<string>(); // `import * as cf from "cloudflare:workers"`: cf.env counts
  const processes = new Set(["process"]); // `import proc from "node:process"`: proc.env counts
  for (const s of program.body) {
    if (s.type !== "ImportDeclaration" || typeOnly(s)) continue;
    const from = s.source.value;
    for (const sp of s.specifiers) {
      if (sp.importKind === "type") continue;
      if (sp.type === "ImportSpecifier" && sp.imported?.name === "env" && (from === "cloudflare:workers" || ENV_PACKAGES.has(from)))
        found.push({ what: `env from "${from}"`, at: loc(s.start) });
      if (sp.type !== "ImportSpecifier" && from === "cloudflare:workers") cf.add(sp.local.name);
      if (sp.type !== "ImportSpecifier" && ENV_PACKAGES.has(from)) processes.add(sp.local.name);
    }
  }
  const isProcess = (n: Node | undefined): boolean => {
    const o = unwrap(n);
    if (o?.type === "Identifier") return processes.has(o.name);
    return o?.type === "MemberExpression" && !o.computed && o.property?.name === "process" && ["globalThis", "global", "window", "self"].includes(o.object?.name);
  };
  walk(program, (n) => {
    if (n.type === "MemberExpression") {
      const key = n.computed ? (n.property?.type === "Literal" ? n.property.value : undefined) : n.property?.name;
      if (key !== "env") return;
      const o = unwrap(n.object);
      if (isProcess(o)) found.push({ what: "process.env", at: loc(n.start) });
      else if (o?.type === "MetaProperty") found.push({ what: "import.meta.env", at: loc(n.start) });
      else if (o?.type === "Identifier" && o.name === "Bun") found.push({ what: "Bun.env", at: loc(n.start) });
      else if (o?.type === "Identifier" && cf.has(o.name)) found.push({ what: 'env from "cloudflare:workers"', at: loc(n.start) });
    }
    // const { env } = process
    if (n.type === "VariableDeclarator" && n.id?.type === "ObjectPattern" && isProcess(n.init) && n.id.properties.some((p: Node) => p.key?.name === "env"))
      found.push({ what: "process.env", at: loc(n.start) });
  });
  return found;
};

/** `x.transaction(...)`, on anything: modules never open a transaction (a mutation already is one). */
const directTransactions = (program: Node, loc: (o: number) => Loc): Hit[] => {
  const found: Hit[] = [];
  walk(program, (n) => {
    const callee = n.type === "CallExpression" ? unwrap(n.callee) : undefined;
    if (callee?.type === "MemberExpression" && !callee.computed && callee.property?.name === "transaction") found.push({ what: ".transaction()", at: loc(n.start) });
  });
  return found;
};

/** A Drizzle client created: `drizzle(...)` imported from a driver entry, `drizzle-orm/<driver>`. */
const directDbClients = (program: Node, loc: (o: number) => Loc): Hit[] => {
  const makers = new Map<string, string>(); // local name → the entry it came from
  for (const s of program.body) {
    if (s.type !== "ImportDeclaration" || typeOnly(s) || !s.source.value.startsWith("drizzle-orm/")) continue;
    for (const sp of s.specifiers)
      if (sp.type === "ImportSpecifier" && sp.importKind !== "type" && sp.imported?.name === "drizzle") makers.set(sp.local.name, s.source.value);
  }
  const found: Hit[] = [];
  if (makers.size)
    walk(program, (n) => {
      const callee = n.type === "CallExpression" ? unwrap(n.callee) : undefined;
      const from = callee?.type === "Identifier" ? makers.get(callee.name) : undefined;
      if (from) found.push({ what: `drizzle() from "${from}"`, at: loc(n.start) });
    });
  return found;
};

/** Record checks must be sync and their result used. */
function canIssues(program: Node, loc: (o: number) => Loc): CanIssue[] {
  const cans: CanIssue[] = [];
  walk(program, (n) => {
    const fnName =
      n.type === "FunctionDeclaration" ? n.id?.name
      : n.type === "VariableDeclarator" && isFunction(unwrap(n.init)) ? n.id?.name
      : (n.type === "Property" || n.type === "MethodDefinition") && isFunction(n.value) ? n.key?.name
      : undefined;
    const fnNode = n.type === "FunctionDeclaration" ? n : n.type === "VariableDeclarator" ? unwrap(n.init) : n.value;
    if (fnName && CAN.test(fnName) && fnNode?.async) cans.push({ code: "async-can", name: fnName, how: "declared", at: loc(n.start) });
    /** The can* an expression calls, if that's what it is. */
    const canCalled = (e: Node | undefined) => {
      const name = e?.type === "CallExpression" ? calleeName(e) : undefined;
      return name && CAN.test(name) ? name : undefined;
    };
    const awaited = n.type === "AwaitExpression" ? canCalled(unwrap(n.argument)) : undefined;
    if (awaited) cans.push({ code: "async-can", name: awaited, how: "awaited", at: loc(n.start) });
    const discarded = n.type === "ExpressionStatement" ? canCalled(unwrap(n.expression)) : undefined;
    if (discarded) cans.push({ code: "unused-can", name: discarded, how: "discarded", at: loc(n.start) });
  });
  return cans;
}

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

  const parsed = new Map<string, ReturnType<typeof parse>>();
  const read = (file: string) => {
    let r = parsed.get(file);
    if (!r) parsed.set(file, (r = parse(file)));
    return r;
  };
  const parse = (file: string) => {
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

  const moduleOf = (file: string) => {
    const found = Object.entries(modules).find(([, m]) => file === m.dir || (m.folder && file.startsWith(m.dir + sep)));
    return found && { name: found[0], ...found[1] };
  };

  /** `import * as links from "<this>"`: the spec without the inner path when it ends with it, else a relative path. */
  const indexSpec = (spec: string, fromFile: string, resolved: string, m: { dir: string; index: string; folder: boolean }) => {
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
      for (const sp of decl?.specifiers ?? []) local[sp.local.name] = { mod: target.name, ns: sp.type === "ImportNamespaceSpecifier" };
      if (target.name !== from)
        imports.push({
          from,
          spec,
          target: target.name,
          internal: resolved !== target.index,
          index: indexSpec(spec, file, resolved, target),
          at: loc(start),
        });
    }
    return local;
  };

  type File = ReturnType<typeof read> & { nameOf: (arg: Node | undefined) => string };
  type Found = Pick<SourceFn, "runs" | "emits" | "checks" | "config">;

  /** App files a file loads at runtime (not packages, not modules, not type-only imports). */
  const appImports = (file: string, program: Node) =>
    specifiers(program, true).flatMap(({ spec, start }) => {
      const target = resolve(file, spec);
      return target && !target.includes(`${sep}node_modules${sep}`) && !moduleOf(target) ? [{ target, start }] : [];
    });
  /**
   * What a module file does itself, or through the app files it loads. `direct` finds it in one file; the first one in
   * an imported file is reported at the import. Memoized, so each file is looked at once.
   */
  const reach = (direct: (program: Node, loc: (o: number) => Loc) => Hit[]) => {
    const found: Reached[] = [];
    const memo = new Map<string, Hit | null>();
    const via = (file: string, visiting: Set<string>): Hit | null => {
      const known = memo.get(file);
      if (known !== undefined) return known;
      if (visiting.has(file)) return null; // a cycle: whatever is there is found from where the cycle started
      visiting.add(file);
      const { program, loc } = read(file);
      let first = direct(program, loc)[0] ?? null;
      if (!first)
        for (const { target } of appImports(file, program)) {
          first = via(target, visiting);
          if (first) break;
        }
      visiting.delete(file);
      memo.set(file, first);
      return first;
    };
    const scan = (mod: string, file: string, program: Node, loc: (o: number) => Loc) => {
      for (const r of direct(program, loc)) found.push({ module: mod, ...r });
      for (const { target, start } of appImports(file, program)) {
        const first = via(target, new Set());
        if (first) found.push({ module: mod, what: first.what, at: loc(start), via: first.at });
      }
    };
    return { found, scan };
  };
  // Modules get settings from ctx.config, never open a transaction (a mutation is one), and reach the database only
  // through ctx.db: neither they nor what they import read env, call .transaction() or create a client.
  const env = reach(directEnv);
  const transactions = reach(directTransactions);
  const dbClients = reach(directDbClients);

  for (const [mod, { dir, folder, index }] of Object.entries(modules)) {
    const files: File[] = (folder ? sourceFiles(dir) : [index]).map((f) => {
      const file = read(f);
      for (const r of [env, transactions, dbClients]) r.scan(mod, f, file.program, file.loc);
      const local = scanImports(f, file.program, file.loc, mod);
      const nameOf = (arg: Node | undefined): string => {
        const ns = arg?.type === "MemberExpression" && arg.object?.type === "Identifier" ? local[arg.object.name] : undefined;
        if (ns?.ns) return `${ns.mod}.${arg?.property.name}`;
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
          for (const d of s.declarations) {
            const fn = unwrap(d.init);
            if (d.id?.type === "Identifier" && isFunction(fn)) add(d.id.name, fn);
          }
      }
    /** `{ scope: { actor: system } }` in run options → the keys it changes; "(dynamic)" when they can't be read. */
    const scopeOf = (options: Node | undefined): { scope?: string[] } => {
      const o = unwrap(options);
      if (!o) return {};
      if (o.type !== "ObjectExpression") return { scope: ["(dynamic)"] };
      const prop = o.properties.find((p: Node) => p.key?.name === "scope");
      if (!prop) return {};
      const value = unwrap(prop.value);
      if (value?.type !== "ObjectExpression") return { scope: ["(dynamic)"] };
      return { scope: value.properties.map((p: Node) => p.key?.name ?? p.key?.value ?? "(dynamic)") };
    };
    const readConfig = (found: Found, key: string | undefined) => {
      if (key === undefined) return;
      const k = key || "*"; // "*": all of it escaped (passed on whole), so any key may be read
      if (!found.config.includes(k)) found.config.push(k);
    };
    const follow = (node: unknown, file: File, ctx: ReturnType<typeof ctxIn>, found: Found, seen: Set<Node>) => {
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
        else if (name && CAN.test(name)) {
          if (!found.checks.includes(name)) found.checks.push(name);
        } else if (name && n.callee.type === "Identifier")
          for (const h of helpers.get(name) ?? []) {
            if (seen.has(h.node)) continue;
            seen.add(h.node);
            follow(h.node.body, h.file, ctxIn([h.node], "any"), found, seen);
          }
      });
    };

    for (const file of files) {
      const { program, loc, docAt } = file;

      cans.push(...canIssues(program, loc));
      for (const s of program.body) {
        const decl = s.type === "ExportNamedDeclaration" ? s.declaration?.declarations?.[0] : undefined;
        const call = unwrap(decl?.init);
        if (call?.type !== "CallExpression" || decl.id?.type !== "Identifier") continue;
        const fn: SourceFn = { key: `${mod}.${decl.id.name}`, at: loc(decl.start), runs: [], emits: [], checks: [], config: [], fetches: [], dates: [], doc: docAt(s.start) };

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
        // ctx is the first parameter: `handler(ctx, input)` in a function, `handler(ctx, payload)` in a listener
        const handlers = props.filter((p) => p.key?.name === "handler").map((p) => p.value).filter(isFunction);
        follow(call.arguments, file, ctxIn(handlers, 0), fn, new Set());
        // keep the most specific keys: `orders.maxItems`, not also `orders`
        fn.config = fn.config.includes("*") ? ["*"] : fn.config.filter((k) => !fn.config.some((o) => o.startsWith(k + "."))).sort();
        fns.set(fn.key, fn);
      }
    }
  }

  // Everything else under the registry's folder (routes, pages, scripts) reaches modules only through their index.
  for (const file of sourceFiles(dirname(registryFile)))
    if (!moduleOf(file)) {
      const { program, loc } = read(file);
      scanImports(file, program, loc, null);
    }

  return { modules, fns, imports, cans, env: env.found, transactions: transactions.found, dbClients: dbClients.found };
}
