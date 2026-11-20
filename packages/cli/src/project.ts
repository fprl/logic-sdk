// Loads an app built with logic-sdk: its modules through jiti (the real objects), plus what the source says (analyze.ts).
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { analyze, type Edge, type Loc } from "./analyze.ts";

export interface FnInfo {
  id: string;
  module: string;
  name: string;
  kind: "query" | "mutation" | "action";
  description: string | null; // the JSDoc above it, first paragraph
  authorize: string | null; // the policy as written in source ("member"), "inline", or null without authorize
  exposed: boolean; // expose: true, so adapters may publish it
  takesInput: boolean; // false: declared without `input`, so it's called as run(fn)
  input: JsonSchema | null;
  output: JsonSchema | null;
  meta: unknown;
  at: Loc | null;
  runs: Edge[];
  emits: Edge[];
  checks: string[]; // can*(...) record checks in its body or this module's helpers it calls
  config: string[]; // ctx.config keys it reads ("orders.maxItems"), in its body or this module's helpers it calls
  calledBy: string[];
}
export interface ListenerInfo {
  id: string;
  module: string;
  event: string;
  description: string | null;
  at: Loc | null;
  runs: Edge[];
}
export interface EventInfo {
  id: string;
  emittedBy: string[];
  listeners: string[];
}
export type JsonSchema = Record<string, any>;
export interface Project {
  root: string;
  registryFile: string;
  modules: string[];
  functions: FnInfo[];
  listeners: ListenerInfo[];
  events: EventInfo[];
  source: ReturnType<typeof analyze>;
}

/** An expected failure: printed as a diagnostic, exit code 1 (or 2 for usage). */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}

const DEFAULT_REGISTRY = "src/registry.ts";

/** `src/registry.ts`, unless package.json says otherwise: `"logic-sdk": { "registry": "lib/registry.ts" }`. */
function registryPath(root: string) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg["logic-sdk"]?.registry ?? DEFAULT_REGISTRY;
  } catch {
    return DEFAULT_REGISTRY;
  }
}

function jsonSchemaOf(schema: any, direction: "input" | "output"): JsonSchema | null {
  try {
    return schema?.["~standard"]?.jsonSchema?.[direction]({ target: "draft-2020-12" }) ?? null;
  } catch {
    return null; // a schema that can't be expressed as JSON Schema (e.g. a transform): shown as unknown
  }
}

export async function loadProject(root: string): Promise<Project> {
  const registry = registryPath(root);
  const registryFile = join(root, registry);
  if (!existsSync(registryFile))
    throw new CliError(
      "no-registry",
      `No ${registry} in ${root}.`,
      `Run logic-sdk from your app's root. If your registry lives elsewhere, point to it in package.json: "logic-sdk": { "registry": "lib/registry.ts" }.`,
    );

  const source = analyze(root, registryFile);
  const jiti = createJiti(pathToFileURL(registryFile).href, { interopDefault: true, tsconfigPaths: true });

  /** Importing the app runs its top-level code: when that throws, say where, not a raw stack trace. */
  const load = async (spec: string) => {
    try {
      return (await jiti.import(spec)) as Record<string, any>;
    } catch (error) {
      const e = error as Error;
      const frame = e.stack?.split("\n").find((l) => l.includes(root) && !l.includes("node_modules"));
      const where = frame?.match(/(\/[^():\s]+):(\d+):(\d+)/);
      // A module reading the platform's env (cloudflare:workers) can't even load outside it: say that, not just the crash
      // Only when the crash is that import, and a module reads env through it: never blame an unrelated read
      const env = e.message.includes("cloudflare:workers") ? source.env.find((r) => r.what.includes("cloudflare:workers")) : undefined;
      throw new CliError(
        "app-load-failed",
        `Loading your app failed: ${e.message}${where ? ` (${relative(root, where[1]!)}:${where[2]}:${where[3]})` : ""}`,
        env
          ? `${env.at.file}:${env.at.line} reads the environment (${env.what}), which modules don't do. Read the value from ctx.config, filled from your env at the entry: createRegistry({ config }).`
          : "Fix that error first. The CLI imports your modules the same way your app does, without connecting to anything.",
      );
    }
  };

  // The app's own logic-sdk, so the CLI reads modules with the version the app runs.
  const core = (await load("logic-sdk")) as { describeModules?: (m: Record<string, object>) => any };
  if (typeof core.describeModules !== "function")
    throw new CliError("core-too-old", "This app's logic-sdk has no describeModules().", "Update logic-sdk.");

  const modules: Record<string, object> = {};
  for (const [key, { index }] of Object.entries(source.modules)) modules[key] = await load(index);
  const described = core.describeModules(modules);

  const at = (id: string) => source.fns.get(id)?.at ?? null;
  const functions: FnInfo[] = described.functions.map((f: any) => {
    const s = source.fns.get(f.id);
    return {
      id: f.id,
      module: f.module,
      name: f.name,
      kind: f.kind,
      description: s?.doc ?? null,
      // the name as written in source; else the function's own name (`const member = …` names it), else "inline"
      authorize: f.fn.authorize ? (s?.authorize ?? (f.fn.authorize.name || "inline")) : null,
      exposed: f.exposed === true,
      takesInput: f.fn.input !== undefined,
      input: f.fn.input ? jsonSchemaOf(f.fn.input, "input") : null,
      output: f.fn.output ? jsonSchemaOf(f.fn.output, "output") : null,
      meta: f.fn.meta ?? null,
      at: at(f.id),
      runs: s?.runs ?? [],
      emits: s?.emits ?? [],
      checks: s?.checks ?? [],
      config: s?.config ?? [],
      calledBy: [],
    };
  });
  const listeners: ListenerInfo[] = described.listeners.map((l: any) => ({
    id: l.id,
    module: l.module,
    event: described.ids.get(l.event) ?? "(unknown)",
    description: source.fns.get(l.id)?.doc ?? null,
    at: at(l.id),
    runs: source.fns.get(l.id)?.runs ?? [],
  }));

  const byId = new Map(functions.map((f) => [f.id, f]));
  for (const caller of [...functions, ...listeners])
    for (const edge of caller.runs) byId.get(edge.to)?.calledBy.push(caller.id);

  const events: EventInfo[] = described.events.map((e: any) => ({
    id: e.id,
    emittedBy: functions.filter((f) => f.emits.some((x) => x.to === e.id)).map((f) => f.id),
    listeners: listeners.filter((l) => l.event === e.id).map((l) => l.id),
  }));

  return {
    root,
    registryFile: relative(root, registryFile),
    modules: Object.keys(modules),
    functions,
    listeners,
    events,
    source,
  };
}
