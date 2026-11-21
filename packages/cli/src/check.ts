// The rules from the logic-sdk skill (skills/logic-sdk/SKILL.md), checked against the project. Each problem says where and how to fix it.
import { relative } from "node:path";
import type { Loc } from "./analyze.ts";
import type { Project } from "./project.ts";

export interface Problem {
  code: string;
  severity: "error" | "warning";
  message: string;
  at: Loc | null;
  fix: string;
}

export function check(project: Project): Problem[] {
  const problems: Problem[] = [];
  const { source } = project;

  // 1. Modules reach each other only through their index, and so does code outside them (routes, pages)
  for (const i of source.imports)
    if (i.internal)
      problems.push({
        code: "cross-module-import",
        severity: "error",
        message: i.from
          ? `${i.from} imports "${i.spec}", a file inside ${i.target}. Other modules are reachable only through their index.`
          : `${i.at.file} imports "${i.spec}", a file inside ${i.target}. Code outside the modules reaches them only through their index.`,
        at: i.at,
        fix: i.from
          ? `Import it as \`import * as ${i.target} from "${i.index}"\` and call its functions with ctx.run(${i.target}.fn, input).`
          : `Import it as \`import * as ${i.target} from "${i.index}"\` and call its functions through the registry: caller.run(${i.target}.fn, input).`,
      });

  // 2. No run cycles between modules (an event breaks them)
  const graph = new Map<string, Map<string, string>>(); // module → module → an example "a.fn → b.fn"
  for (const f of [...project.functions, ...project.listeners])
    for (const e of f.runs) {
      const to = e.to.split(".")[0]!;
      if (e.to === "(dynamic)") {
        // Never pass silently: an edge we can't name could close a cycle
        problems.push({
          code: "dynamic-run",
          severity: "warning",
          message: `${f.id} runs a function the CLI can't name from the source, so run cycles through it aren't checked.`,
          at: e.at,
          fix: "Pass the function itself: ctx.run(otherModule.fn, input), with otherModule imported from its index.",
        });
        continue;
      }
      if (to === f.module) continue;
      if (!graph.has(f.module)) graph.set(f.module, new Map());
      if (!graph.get(f.module)!.has(to)) graph.get(f.module)!.set(to, `${f.id} → ${e.to}`);
    }
  for (const cycle of cycles(graph)) {
    const steps = cycle.map((m, i) => graph.get(m)!.get(cycle[(i + 1) % cycle.length]!)!);
    problems.push({
      code: "run-cycle",
      severity: "error",
      message: `Modules run each other in a circle: ${[...cycle, cycle[0]].join(" → ")} (${steps.join(", ")}).`,
      at: null,
      fix: "Break the cycle with an event: emit it in one module, react with a listener in the other.",
    });
  }

  for (const fn of [...project.functions, ...project.listeners]) {
    const f = source.fns.get(`${fn.module}.${fn.name}`);
    // Never pass silently: what we can't read, we can't check
    if (!f) {
      problems.push({
        code: "source-not-found",
        severity: "warning",
        message: `${fn.id} is registered, but its definition wasn't found in ${fn.module}'s files, so its calls aren't checked.`,
        at: null,
        fix: `Define it as \`export const ${fn.name} = …({ … })\` in ${relative(project.root, source.modules[fn.module]!.dir)}${source.modules[fn.module]!.folder ? "/" : ""}.`,
      });
      continue;
    }
    const kind = "kind" in fn ? fn.kind : "listener";
    // 3. No network calls inside a transaction
    if (kind === "query" || kind === "mutation")
      for (const at of f.fetches)
        problems.push({
          code: "network-in-transaction",
          severity: "error",
          message: `${f.id} is a ${kind} and calls fetch(). It can roll back, and a network call can't be undone.`,
          at,
          fix: "Move the call to an action that runs the mutation, or emit an event and react in a listener.",
        });
    // 4. Time comes from ctx.now()
    for (const at of f.dates)
      problems.push({
        code: "wall-clock",
        severity: "warning",
        message: `${f.id} reads the clock directly, so tests can't freeze it.`,
        at,
        fix: "Use ctx.now() instead of new Date() or Date.now().",
      });
  }

  // 5. Record checks (can*) are sync and their result is used: `if (!canCancel(actor, order)) throw ctx.errors.deny()`
  for (const c of source.cans)
    problems.push(
      c.code === "unused-can"
        ? {
            code: "unused-can",
            severity: "error",
            message: `The result of ${c.name}(...) is thrown away, so nothing is denied.`,
            at: c.at,
            fix: `Use it: if (!${c.name}(ctx.scope.actor, record)) throw ctx.errors.deny();`,
          }
        : {
            code: "async-can",
            severity: "error",
            message: `${c.name} ${c.how === "declared" ? "is async" : "is awaited"}, so it returns a Promise. A Promise is never falsy: if (!${c.name}(...)) never denies and the check silently passes.`,
            at: c.at,
            fix: `Make ${c.name} a plain sync function: load the record first through a data.ts helper, then pass it in, ${c.name}(ctx.scope.actor, record).`,
          },
    );

  // 6. Settings come from ctx.config: modules (and the app files they import) never read the environment
  for (const r of source.env)
    problems.push({
      code: "env-in-module",
      severity: "error",
      message: r.via
        ? `${r.at.file} imports a file that reads the environment (${r.what} at ${r.via.file}:${r.via.line}). Modules don't read env, directly or through imports.`
        : `${r.at.file} reads the environment (${r.what}). Modules don't read env, so tests can change settings and the CLI can load them.`,
      at: r.at,
      fix: "Read the value from ctx.config: declare it in Config's `config` in logic.ts, and fill it from your env at the entry, createRegistry({ config }). Clients built from secrets go in services.",
    });

  // 7. Listeners for events nothing emits
  for (const e of project.events)
    if (e.listeners.length && !e.emittedBy.length)
      problems.push({
        code: "event-never-emitted",
        severity: "warning",
        message: `${e.listeners.join(", ")} ${e.listeners.length > 1 ? "listen" : "listens"} to ${e.id}, but no function emits it.`,
        at: project.listeners.find((l) => l.event === e.id)?.at ?? null,
        fix: `Emit it with ctx.emit(${e.id.split(".")[1]}, payload) in a mutation of ${e.id.split(".")[0]}, or remove the listener.`,
      });

  return problems;
}

/** Elementary cycles, each reported once (smallest rotation). Module graphs are tiny, so a plain DFS is enough. */
function cycles(graph: Map<string, Map<string, string>>): string[][] {
  const found = new Map<string, string[]>();
  const visit = (start: string, node: string, path: string[]) => {
    for (const next of graph.get(node)?.keys() ?? []) {
      if (next === start) {
        const min = path.indexOf([...path].sort()[0]!);
        const rotated = [...path.slice(min), ...path.slice(0, min)];
        found.set(rotated.join(","), rotated);
      } else if (!path.includes(next)) visit(start, next, [...path, next]);
    }
  };
  for (const start of graph.keys()) visit(start, start, [start]);
  return [...found.values()];
}
