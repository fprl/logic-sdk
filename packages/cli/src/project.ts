// Loads an app built with logic-sdk: its modules through jiti (the real objects), plus what the source says (analyze.ts).
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type * as Core from "logic-sdk";
import { analyze, type Edge, type Loc } from "./analyze.ts";

export interface FnInfo {
  /** The registry's id. A private function has none: `files.(private) record`, its name in traces plus its variable name, or `files.<id>` when it sets `id`. */
  id: string;
  /** Its module's index doesn't export it: only `ctx.run` from that module's own code runs it. */
  private: boolean;
  module: string;
  name: string;
  kind: "query" | "mutation" | "action";
  description: string | null; // the JSDoc above it, first paragraph
  authorize: string | null; // the policy as written in source ("member"), "inline", or null without authorize
  takesInput: boolean; // false: declared without `input`, so it's called as run(fn)
  input: JsonSchema | null;
  output: JsonSchema | null;
  meta: unknown;
  at: Loc | null;
  runs: Edge[];
  emits: Edge[];
  schedules: Edge[];
  checks: string[]; // can*(...) record checks in its body or this module's helpers it calls
  config: string[]; // ctx.config keys it reads ("orders.maxItems"), in its body or this module's helpers it calls
  calledBy: string[];
}
export interface ListenerInfo {
  id: string;
  module: string;
  /** The export name: how the source refers to it (the id can differ). */
  name: string;
  event: string;
  /** It has a `when`: some events of its kind get no job for it. */
  conditional: boolean;
  description: string | null;
  at: Loc | null;
  runs: Edge[];
}
export interface CronInfo {
  id: string;
  module: string;
  name: string;
  schedule: string;
  timezone: string;
  /** The function it runs. */
  run: string;
  description: string | null;
  at: Loc | null;
}
export interface EventInfo {
  id: string;
  module: string;
  /** The export name: how the source refers to it (the id can differ). */
  name: string;
  emittedBy: string[];
  listeners: string[];
}
export type JsonSchema = Record<string, any>;
/** A listener, cron or event no module's index exports: the registry never sees it, so it never runs. */
export interface UnregisteredInfo {
  module: string;
  name: string;
  kind: "listener" | "cron" | "event";
  description: string | null;
  at: Loc;
}
export interface Project {
  root: string;
  modules: string[];
  functions: FnInfo[];
  listeners: ListenerInfo[];
  crons: CronInfo[];
  events: EventInfo[];
  unregistered: UnregisteredInfo[];
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
      const e = error instanceof Error ? error : new Error(String(error)); // top-level code can throw anything
      const frame = e.stack?.split("\n").find((l) => l.includes(root) && !l.includes("node_modules"));
      const where = frame?.match(/(\/[^():\s]+):(\d+):(\d+)/);
      throw new CliError(
        "app-load-failed",
        `Loading your app failed: ${e.message}${where ? ` (${relative(root, where[1]!)}:${where[2]}:${where[3]})` : ""}`,
        "Fix that error first. The CLI imports your modules the same way your app does, without connecting to anything.",
      );
    }
  };

  // The app's own logic-sdk, so the CLI reads modules with the version the app runs.
  const core = (await load("logic-sdk")) as typeof Core; // SAFETY: the peer range pins the app's logic-sdk to this CLI's

  const modules: Record<string, object> = {};
  for (const [key, { entry }] of Object.entries(source.modules)) modules[key] = await load(entry);
  const described = core.describeModules(modules);

  // Source is keyed by `<module>.<export>`; ids can differ when a definition sets its own `id`.
  const idByExport = new Map<string, string>();
  for (const d of [...described.functions, ...described.events, ...described.listeners, ...described.crons]) idByExport.set(`${d.module}.${d.name}`, d.id);
  const real = <E extends { to: string }>(edges: E[]) => edges.map((e) => ({ ...e, to: idByExport.get(e.to) ?? e.to }));
  const src = (d: { module: string; name: string }) => source.fns.get(`${d.module}.${d.name}`);
  const functions: FnInfo[] = described.functions.map((f) => {
    const s = src(f);
    return {
      id: f.id,
      private: false,
      module: f.module,
      name: f.name,
      kind: f.kind,
      description: s?.doc ?? null,
      // the name as written in source; else the function's own name (`const member = …` names it), else "inline"
      authorize: f.fn.authorize ? (s?.authorize ?? (f.fn.authorize.name || "inline")) : null,
      takesInput: f.fn.input !== undefined,
      input: f.fn.input ? jsonSchemaOf(f.fn.input, "input") : null,
      output: f.fn.output ? jsonSchemaOf(f.fn.output, "output") : null,
      meta: f.fn.meta ?? null,
      at: s?.at ?? null,
      runs: real(s?.runs ?? []),
      emits: real(s?.emits ?? []),
      schedules: real(s?.schedules ?? []),
      checks: s?.checks ?? [],
      config: s?.config ?? [],
      calledBy: [],
    };
  });
  // private functions: only what the source says (their schemas would need the file loaded, and one may not be exported from it)
  for (const u of source.unreached)
    if (u.kind === "query" || u.kind === "mutation" || u.kind === "action")
      functions.push({
        id: u.key,
        private: true,
        module: u.module,
        name: u.name,
        kind: u.kind,
        description: u.doc ?? null,
        authorize: u.authorize ?? null,
        takesInput: u.takesInput,
        input: null,
        output: null,
        meta: null,
        at: u.at,
        runs: real(u.runs),
        emits: real(u.emits),
        schedules: real(u.schedules),
        checks: u.checks,
        config: u.config,
        calledBy: [],
      });
  const unregistered = source.unreached.flatMap((u) =>
    u.kind === "listener" || u.kind === "cron" || u.kind === "event" ? [{ module: u.module, name: u.name, kind: u.kind, description: u.doc ?? null, at: u.at }] : [],
  );
  const listeners: ListenerInfo[] = described.listeners.map((l) => ({
    id: l.id,
    module: l.module,
    name: l.name,
    event: described.ids.get(l.event) ?? "(unknown)",
    conditional: l.listener.when !== undefined,
    description: src(l)?.doc ?? null,
    at: src(l)?.at ?? null,
    runs: real(src(l)?.runs ?? []),
  }));

  const byId = new Map(functions.map((f) => [f.id, f]));
  for (const caller of [...functions, ...listeners])
    for (const edge of [...caller.runs, ...("schedules" in caller ? caller.schedules : [])]) {
      const callee = byId.get(edge.to);
      if (callee && !callee.calledBy.includes(caller.id)) callee.calledBy.push(caller.id);
    }

  const crons: CronInfo[] = described.crons.map((c) => ({
    id: c.id,
    module: c.module,
    name: c.name,
    schedule: c.cron.schedule,
    timezone: c.cron.timezone ?? "UTC",
    run: described.ids.get(c.run) ?? "(unknown)",
    description: src(c)?.doc ?? null,
    at: src(c)?.at ?? null,
  }));
  for (const c of crons) byId.get(c.run)?.calledBy.push(c.id);

  const events: EventInfo[] = described.events.map((e) => ({
    id: e.id,
    module: e.module,
    name: e.name,
    emittedBy: functions.filter((f) => f.emits.some((x) => x.to === e.id)).map((f) => f.id),
    listeners: listeners.filter((l) => l.event === e.id).map((l) => l.id),
  }));

  return {
    root,
    modules: Object.keys(modules),
    functions,
    listeners,
    crons,
    events,
    unregistered,
  };
}
