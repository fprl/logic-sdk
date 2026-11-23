import { buildApplication, buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { ParseError } from "./analyze.ts";
import { check } from "./check.ts";
import { CliError, loadProject, type CronInfo, type FnInfo, type ListenerInfo, type Project } from "./project.ts";
import { bold, diagnostic, dim, kind, paint, shape, table, where } from "./render.ts";

export interface Context extends CommandContext {
  readonly process: NodeJS.Process;
  readonly cwd: string;
}

const json = { kind: "boolean", brief: "Print JSON (for scripts and agents)", optional: true } as const;
const out = (ctx: Context, text: string) => ctx.process.stdout.write(text + "\n");
const print = (ctx: Context, value: unknown) => out(ctx, JSON.stringify(value, null, 2));

/** Expected failures become a diagnostic (or a JSON error with --json) and exit code 1, or 2 for bad input. */
function guarded<F extends object, A extends unknown[]>(func: (this: Context, flags: F, ...args: A) => Promise<unknown>) {
  return async function (this: Context, flags: F, ...args: A): Promise<void> {
    try {
      await func.call(this, flags, ...args);
    } catch (error) {
      const known = error instanceof CliError ? error : error instanceof ParseError ? new CliError("unreadable-registry", error.message) : null;
      if (!known) throw error;
      this.process.exitCode = known.code === "unknown-name" ? 2 : 1;
      if ("json" in flags && flags.json) {
        print(this, { error: { code: known.code, message: known.message, fix: known.fix ?? null } });
        return;
      }
      this.process.stderr.write(`${paint(["red", "bold"], "✗", this.process.stderr)} ${bold(known.code)}\n  ${known.message}\n${known.fix ? `  ${paint("green", "fix:", this.process.stderr)} ${known.fix}\n` : ""}`);
    }
  };
}

/** "member exposed", "member internal", or "internal" with no policy. */
const access = (f: { authorize: string | null; exposed: boolean }) =>
  [f.authorize, f.exposed ? paint("green", "exposed") : dim("internal")].filter(Boolean).join(" ");
/** "tasks.assign (scope: actor)": the run, and the scope keys it changes on purpose. */
const runLabel = (e: { to: string; scope?: string[] }) => (e.scope ? `${e.to} (scope: ${e.scope.join(", ")})` : e.to);
const scopeChanges = (runs: { to: string; scope?: string[] }[]) => runs.flatMap((e) => (e.scope ? [{ run: e.to, keys: e.scope }] : []));
const plainRuns = <T extends FnInfo | ListenerInfo>(x: T) => ({ ...x, runs: x.runs.map((e) => e.to), scopeChanges: scopeChanges(x.runs) });
const plainFn = (f: FnInfo) => ({ ...plainRuns(f), emits: f.emits.map((e) => e.to) });
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── list ─────────────────────────────────────────────────────────────────────
const list = buildCommand({
  docs: { brief: "List every function, listener and cron, like a route list" },
  parameters: {
    flags: {
      module: { kind: "parsed", parse: String, brief: "Only this module", optional: true },
      kind: { kind: "enum", values: ["query", "mutation", "action", "listener", "cron"], brief: "Only this kind", optional: true },
      exposed: { kind: "boolean", brief: "Only functions with expose: true", optional: true },
      json,
    },
  },
  func: guarded(async function (this: Context, flags: { module?: string; kind?: FnInfo["kind"] | "listener" | "cron"; exposed?: boolean; json?: boolean }) {
    const p = await loadProject(this.cwd);
    const rows = [
      ...p.functions.map((f) => plainFn(f)),
      ...p.listeners.map((l) => ({ id: l.id, module: l.module, kind: "listener" as const, authorize: null, exposed: false, description: l.description ?? `on ${l.event}`, event: l.event })),
      ...p.crons.map((c) => ({ ...c, kind: "cron" as const, authorize: null, exposed: false, description: `${c.schedule} ${c.timezone} → ${c.run}` })),
    ].filter(
      (r) => (!flags.module || r.module === flags.module) && (!flags.kind || r.kind === flags.kind) && (!flags.exposed || r.exposed),
    );
    if (flags.json) return print(this, rows);
    out(this, table(["NAME", "KIND", "ACCESS", "DESCRIPTION"], rows.map((r) => [bold(r.id), kind(r.kind), r.kind === "listener" || r.kind === "cron" ? dim("-") : access(r), r.description ?? ""])));
    out(this, dim(`\n${rows.length} of ${p.functions.length + p.listeners.length + p.crons.length} · logic-sdk show <name> for details`));
  }),
});

// ── show ─────────────────────────────────────────────────────────────────────
const show = buildCommand<{ json?: boolean }, [string], Context>({
  docs: { brief: "Everything about one function, listener, cron or event" },
  parameters: {
    positional: { kind: "tuple", parameters: [{ brief: "e.g. bookings.confirm", parse: String, placeholder: "name" }] },
    flags: { json },
  },
  func: guarded(async function (this: Context, flags: { json?: boolean }, name: string) {
    const p = await loadProject(this.cwd);
    const fn = p.functions.find((f) => f.id === name);
    const listener = p.listeners.find((l) => l.id === name);
    const cron = p.crons.find((c) => c.id === name);
    const event = p.events.find((e) => e.id === name);
    if (!fn && !listener && !cron && !event) throw unknownName(p, name);

    if (flags.json) return print(this, fn ? plainFn(fn) : listener ? plainRuns(listener) : (cron ?? event));

    const lines: string[] = [];
    const row = (label: string, value: string) => lines.push(`${dim(label.padEnd(12))}${value}`);
    const listenersOf = (eventId: string) => p.events.find((e) => e.id === eventId)?.listeners ?? [];

    if (fn) {
      lines.push(`${bold(fn.id)}  ${kind(fn.kind)} ${dim("·")} ${fn.exposed ? paint("green", "exposed") : dim("internal")}`);
      lines.push(...(fn.description ? [fn.description] : []), dim(where(fn.at)), "");
      row("policy", fn.authorize ?? dim("none (no authorize)"));
      row("exposed", fn.exposed ? "yes (adapters may publish it)" : dim("no"));
      row("input", fn.takesInput ? shape(fn.input) : dim("none"));
      row("output", fn.output ? shape(fn.output) : dim(fn.exposed ? "unknown" : "not declared (internal)"));
      if (fn.checks.length) row("checks", fn.checks.join(", "));
      if (fn.config.length) row("config", fn.config[0] === "*" ? "all of it (passed on whole)" : fn.config.join(", "));
      if (fn.runs.length) row("runs", fn.runs.map(runLabel).join(", "));
      for (const e of fn.emits) row("emits", `${e.to} ${dim("→")} ${listenersOf(e.to).join(", ") || dim("no listeners")}`);
      row("called by", fn.calledBy.join(", ") || dim("nothing in this app (an entry point)"));
      if (fn.meta) row("meta", JSON.stringify(fn.meta));
    } else if (listener) {
      lines.push(`${bold(listener.id)}  ${kind("listener")}`, ...(listener.description ? [listener.description] : []), dim(where(listener.at)), "");
      row("on", listener.event);
      if (listener.runs.length) row("runs", listener.runs.map(runLabel).join(", "));
    } else if (cron) {
      lines.push(`${bold(cron.id)}  ${kind("cron")}`, ...(cron.description ? [cron.description] : []), dim(where(cron.at)), "");
      row("schedule", `${cron.schedule} ${dim(cron.timezone)}`);
      row("runs", cron.run);
    } else if (event) {
      lines.push(`${bold(event.id)}  ${dim("event")}`, "");
      row("emitted by", event.emittedBy.join(", ") || dim("nothing"));
      row("listeners", event.listeners.join(", ") || dim("none"));
    }
    out(this, lines.join("\n"));
  }),
});

// ── graph ────────────────────────────────────────────────────────────────────
const graph = buildCommand<{ module?: string; format: "text" | "mermaid" | "json" }, [], Context>({
  docs: { brief: "Who runs whom, and who reacts to which event" },
  parameters: {
    flags: {
      module: { kind: "parsed", parse: String, brief: "Only this module and what it touches", optional: true },
      format: { kind: "enum", values: ["text", "mermaid", "json"], brief: "Output format", default: "text" },
    },
  },
  func: guarded(async function (this: Context, flags: { module?: string; format: "text" | "mermaid" | "json" }) {
    const p = await loadProject(this.cwd);
    const edges = [
      ...p.functions.flatMap((f) => f.runs.map((e) => ({ from: f.id, to: e.to, type: "runs" as const }))),
      ...p.listeners.flatMap((l) => [
        { from: l.event, to: l.id, type: "triggers" as const },
        ...l.runs.map((e) => ({ from: l.id, to: e.to, type: "runs" as const })),
      ]),
      ...p.functions.flatMap((f) => f.emits.map((e) => ({ from: f.id, to: e.to, type: "emits" as const }))),
      ...p.crons.map((c) => ({ from: c.id, to: c.run, type: "runs" as const })),
    ];
    const touches = (id: string) => !flags.module || id.startsWith(flags.module + ".");
    const shown = edges.filter((e) => touches(e.from) || touches(e.to));

    if (flags.format === "json")
      return print(this, {
        nodes: [...p.functions.map((f) => ({ id: f.id, kind: f.kind, authorize: f.authorize, exposed: f.exposed })), ...p.listeners.map((l) => ({ id: l.id, kind: "listener" })), ...p.crons.map((c) => ({ id: c.id, kind: "cron", schedule: c.schedule, timezone: c.timezone })), ...p.events.map((e) => ({ id: e.id, kind: "event" }))].filter((n) => touches(n.id) || shown.some((e) => e.from === n.id || e.to === n.id)),
        edges: shown,
      });

    if (flags.format === "mermaid") {
      const id = (s: string) => s.replace(/[^\w]/g, "_");
      const lines = ["flowchart LR"];
      for (const m of p.modules.filter((m) => !flags.module || m === flags.module || shown.some((e) => e.from.startsWith(m + ".") || e.to.startsWith(m + ".")))) {
        lines.push(`  subgraph ${m}`);
        for (const f of p.functions.filter((f) => f.module === m)) lines.push(`    ${id(f.id)}["${f.name}"]`);
        for (const l of p.listeners.filter((l) => l.module === m)) lines.push(`    ${id(l.id)}(["${l.id.split(".")[1]}"])`);
        for (const c of p.crons.filter((c) => c.module === m)) lines.push(`    ${id(c.id)}{{"${c.name} · ${c.schedule}"}}`);
        lines.push("  end");
      }
      for (const e of shown.filter((e) => e.type === "runs")) lines.push(`  ${id(e.from)} --> ${id(e.to)}`);
      for (const f of p.functions)
        for (const ev of f.emits)
          for (const l of p.listeners.filter((l) => l.event === ev.to))
            if (touches(f.id) || touches(l.id)) lines.push(`  ${id(f.id)} -. ${ev.to} .-> ${id(l.id)}`);
      return out(this, lines.join("\n"));
    }

    const listenersOf = (eventId: string) => p.listeners.filter((l) => l.event === eventId).map((l) => l.id);
    const blocks: string[] = [];
    for (const m of p.modules.filter((m) => !flags.module || m === flags.module)) {
      const members: (FnInfo | ListenerInfo | CronInfo)[] = [
        ...p.functions.filter((f) => f.module === m),
        ...p.listeners.filter((l) => l.module === m),
        ...p.crons.filter((c) => c.module === m),
      ];
      const kindOf = (f: FnInfo | ListenerInfo | CronInfo) => ("kind" in f ? f.kind : "schedule" in f ? "cron" : "listener");
      const width = Math.max(...members.map((f) => f.id.length - m.length - 1));
      const kindWidth = Math.max(...members.map((f) => kindOf(f).length));
      const lines = [bold(m)];
      members.forEach((f, i) => {
        const last = i === members.length - 1;
        const branch = dim(last ? "└─ " : "├─ ");
        const rest = dim(last ? "   " : "│  ");
        const k = kindOf(f);
        const head = `${f.id.slice(m.length + 1).padEnd(width)}  ${kind(k)}${" ".repeat(kindWidth - k.length)}`;
        const details: string[] = [];
        if ("event" in f) details.push(`${dim("on")} ${f.event}`);
        if ("schedule" in f) details.push(`${dim("at")} ${f.schedule} ${dim(f.timezone)}`, `${dim("runs")} ${f.run}`);
        else if (f.runs.length) details.push(`${dim("runs")} ${f.runs.map(runLabel).join(", ")}`);
        if ("emits" in f) for (const e of f.emits) details.push(`${dim("emits")} ${e.to} ${dim("→")} ${listenersOf(e.to).join(", ") || dim("no listeners")}`);
        lines.push(`${branch}${head}${details.length ? "  " + details[0] : ""}`.trimEnd());
        for (const d of details.slice(1)) lines.push(`${rest}${" ".repeat(width + kindWidth + 4)}${d}`);
      });
      blocks.push(lines.join("\n"));
    }
    out(this, blocks.join("\n\n"));
  }),
});

// ── check ────────────────────────────────────────────────────────────────────
const checkCommand = buildCommand({
  docs: { brief: "Check the rules: module boundaries, run cycles, side effects in transactions, record checks" },
  parameters: { flags: { json } },
  func: guarded(async function (this: Context, flags: { json?: boolean }) {
    const p = await loadProject(this.cwd);
    const problems = check(p);
    const errors = problems.filter((x) => x.severity === "error").length;
    if (errors) this.process.exitCode = 1;
    if (flags.json) return print(this, { errors, warnings: problems.length - errors, problems });
    if (!problems.length)
      return out(this, `${paint("green", "✓")} ${count(p.functions.length, "function")}, ${count(p.listeners.length, "listener")}${p.crons.length ? `, ${count(p.crons.length, "cron")}` : ""} in ${count(p.modules.length, "module")}: no problems`);
    out(this, problems.map(diagnostic).join("\n\n"));
    const total = count(errors, "error");
    out(this, `\n${errors ? paint("red", total) : total}, ${count(problems.length - errors, "warning")}`);
  }),
});

function unknownName(p: Project, name: string) {
  const names = [...p.functions.map((f) => f.id), ...p.listeners.map((l) => l.id), ...p.crons.map((c) => c.id), ...p.events.map((e) => e.id)];
  const close = names.filter((n) => n.includes(name) || name.includes(n.split(".")[1] ?? "")).slice(0, 3);
  return new CliError(
    "unknown-name",
    `There's no function, listener, cron or event called "${name}".`,
    close.length ? `Did you mean ${close.join(", ")}?` : "Run logic-sdk list to see every name.",
  );
}

export const app = buildApplication(
  buildRouteMap({
    routes: { list, show, graph, check: checkCommand },
    docs: { brief: "Inspect, graph and check an app built with logic-sdk" },
  }),
  { name: "logic-sdk", scanner: { caseStyle: "allow-kebab-for-camel" } },
);
