// The rules from AGENTS.md, checked against the project. Each problem says where and how to fix it.
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


  // 1. Modules reach each other only through their index
  for (const i of source.imports)
    if (i.internal)
      problems.push({
        code: "cross-module-import",
        severity: "error",
        message: `${i.from} imports "${i.spec}", a file inside ${i.target}. Other modules are reachable only through their index.`,
        at: i.at,
        fix: `Import it as \`import * as ${i.target} from "../${i.target}"\` and call its functions with ctx.run(${i.target}.fn, input).`,
      });

  // 2. No run cycles between modules (an event breaks them)
  const graph = new Map<string, Map<string, string>>(); // module → module → an example "a.fn → b.fn"
  for (const f of [...project.functions, ...project.listeners])
    for (const e of f.runs) {
      const to = e.to.split(".")[0]!;
      if (e.to === "(dynamic)" || to === f.module) continue;
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
      fix: "Break the cycle with an event: emit it in one module, react with on() in the other.",
    });
  }

  for (const fn of [...project.functions, ...project.listeners]) {
    const f = source.fns.get(fn.id);
    // Never pass silently: what we can't read, we can't check
    if (!f) {
      problems.push({
        code: "source-not-found",
        severity: "warning",
        message: `${fn.id} is registered, but its definition wasn't found in ${fn.module}'s files, so its calls aren't checked.`,
        at: null,
        fix: `Define it as \`export const ${fn.id.split(".")[1]} = …({ … })\` in ${relative(project.root, source.modules[fn.module]!.dir)}${source.modules[fn.module]!.folder ? "/" : ""}.`,
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

  // 5. Listeners for events nothing emits
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
