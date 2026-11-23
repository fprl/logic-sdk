import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// The real entry point: the `logic-sdk` command from the main package, which loads this CLI.
const bin = fileURLToPath(new URL("../../logic-sdk/bin/logic-sdk.js", import.meta.url));
const app = fileURLToPath(new URL("../../../examples/bookings", import.meta.url));
const broken = fileURLToPath(new URL("./fixtures/broken", import.meta.url));

/** Runs the built CLI with Node, piped, the way a script or an agent would. */
function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

test("list: every function and listener, with kind and policy", () => {
  const rows = cli(app, "list", "--json").json();
  expect(rows).toContainEqual(expect.objectContaining({ id: "bookings.confirm", kind: "mutation", authorize: "staff", exposed: true }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "availability.hold", kind: "mutation", authorize: null, exposed: false }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "tasks.prepareStay", kind: "listener", event: "bookings.confirmed" }));
});

test("descriptions come from the JSDoc above each export: its first paragraph, on one line", () => {
  const rows: { id: string; description: string | null }[] = cli(app, "list", "--json").json();
  const of = (id: string) => rows.find((r) => r.id === id)?.description;
  expect(of("availability.hold")).toEqual("Reserve a date range on a property's calendar"); // not the "Internal…" paragraph below it
  expect(of("enquiries.winOnBooking")).toEqual("Mark the enquiry won when its booking is confirmed"); // listeners too
  expect(cli(app, "show", "availability.hold", "--json").json().description).toEqual("Reserve a date range on a property's calendar");
  expect(cli(app, "show", "enquiries.winOnBooking").out).toContain("Mark the enquiry won when its booking is confirmed");
});

test("list filters by module, kind and exposure", () => {
  const ids = cli(app, "list", "--module", "bookings", "--exposed", "--json").json().map((r: { id: string }) => r.id);
  expect(ids.sort()).toEqual(["bookings.cancel", "bookings.checkout", "bookings.confirm", "bookings.get", "bookings.request"]);
});

test("show: schemas from the registry, edges from the source (through this module's helpers too)", () => {
  const fn = cli(app, "show", "bookings.confirm", "--json").json();
  expect(fn.input.properties.bookingId).toMatchObject({ type: "string", format: "uuid" });
  expect(fn.output.properties).not.toHaveProperty("accountId");
  expect(fn.runs).toEqual(["availability.hold"]); // in confirmBooking(ctx, id), a data.ts helper
  expect(fn.emits).toEqual(["bookings.confirmed"]);
  expect(fn.calledBy).toEqual([]);
  expect(cli(app, "show", "bookings.confirmPaid", "--json").json().calledBy).toEqual(["bookings.checkout"]);
  expect(fn.at).toMatchObject({ file: "src/bookings/mutations.ts" });
});

test("show an event: who emits it and who listens", () => {
  expect(cli(app, "show", "bookings.confirmed", "--json").json()).toEqual({
    id: "bookings.confirmed",
    module: "bookings",
    name: "confirmed",
    emittedBy: ["bookings.confirm", "bookings.confirmPaid"],
    listeners: ["enquiries.winOnBooking", "tasks.prepareStay"],
  });
});

test("graph: runs, emits and triggers, as JSON or Mermaid", () => {
  const { edges } = cli(app, "graph", "--format", "json").json();
  expect(edges).toContainEqual({ from: "bookings.checkout", to: "bookings.confirmPaid", type: "runs" });
  expect(edges).toContainEqual({ from: "bookings.confirm", to: "bookings.confirmed", type: "emits" });
  expect(edges).toContainEqual({ from: "bookings.confirmed", to: "tasks.prepareStay", type: "triggers" });
  const mermaid = cli(app, "graph", "--format", "mermaid").out;
  expect(mermaid.startsWith("flowchart LR")).toBe(true);
  expect(mermaid).toContain("bookings_confirm -. bookings.confirmed .-> tasks_prepareStay");
});

test("check passes on a clean app", () => {
  const r = cli(app, "check", "--json");
  expect(r.code).toBe(0);
  expect(r.json()).toEqual({ errors: 0, warnings: 0, problems: [] });
});

test("check finds every broken rule, with where and how to fix it, and exits 1", () => {
  const r = cli(broken, "check", "--json");
  expect(r.code).toBe(1);
  const { errors, warnings, problems } = r.json();
  expect([errors, warnings]).toEqual([3, 2]);
  expect(problems.map((p: { code: string }) => p.code).sort()).toEqual([
    "cross-module-import",
    "event-never-emitted",
    "network-in-transaction",
    "run-cycle",
    "wall-clock",
  ]);
  const cross = problems.find((p: { code: string }) => p.code === "cross-module-import");
  expect(cross.at).toEqual({ file: "src/orders/mutations.ts", line: 4, column: 1 });
  expect(cross.fix).toContain('import * as stock from "../stock"');
});

test("mistakes are usage errors (exit 2) with a suggestion", () => {
  const r = cli(app, "show", "confirm", "--json");
  expect(r.code).toBe(2);
  expect(r.json().error).toMatchObject({ code: "unknown-name", fix: expect.stringContaining("bookings.confirm") });
  expect(cli(app, "list", "--nope").code).toBe(2);
});

test("outside an app: a clear error, exit 1", () => {
  const r = cli("/", "list");
  expect(r.code).toBe(1);
  expect(r.err).toContain("no-registry");
});

test("piped output has no color codes", () => {
  expect(cli(app, "list").out).not.toContain("\x1b[");
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const codes = (r: ReturnType<typeof cli>) => r.json().problems.map((p: { code: string }) => p.code).sort();

test("renamed definers (mutation: defineMutation) are checked like any other", () => {
  const r = cli(fixture("renamed"), "check", "--json");
  expect(r.code).toBe(1);
  expect(codes(r)).toEqual(codes(cli(broken, "check", "--json")));
});

test("a module can be a single file, and explicit ids are what the CLI shows and links", () => {
  const r = cli(fixture("files"), "check", "--json");
  // found in source by export name, reported by id
  expect(r.json()).toMatchObject({ errors: 0, warnings: 1, problems: [{ code: "wall-clock", message: expect.stringMatching(/^stock\.hold reads/) }] });
  expect(cli(fixture("files"), "show", "orders.place", "--json").json()).toMatchObject({ runs: ["stock.hold"], emits: ["orders.created"] });
  expect(cli(fixture("files"), "show", "orders.created", "--json").json()).toMatchObject({ emittedBy: ["orders.place"], listeners: ["orders.email"] });
});

test("an app that throws while loading gets a diagnostic with the location, not a stack trace", () => {
  const r = cli(fixture("crash"), "list");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app-load-failed");
  expect(r.err).toContain("ORDERS_API_URL is not set (src/orders/index.ts:3");
  expect(r.err).not.toContain("    at ");
  expect(r.err).toContain("Fix that error first"); // the crash isn't about cloudflare:workers, so no env hint
});

test("an app that throws something that isn't an Error still gets the diagnostic", () => {
  const r = cli(fixture("crash-string"), "list");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app-load-failed");
  expect(r.err).toContain("orders failed to load");
});

test("modules can live anywhere, and package.json can point to the registry", () => {
  const app = fixture("custom"); // registry in lib/, modules in lib/domains/
  expect(cli(app, "check", "--json").json()).toEqual({ errors: 0, warnings: 0, problems: [] });
  expect(cli(app, "show", "orders.place", "--json").json()).toMatchObject({ runs: ["stock.reserve"], at: { file: "lib/domains/orders/index.ts" } });
});

test("without @logic-sdk/cli installed, the command says how to add it", async () => {
  const { mkdtempSync, copyFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "logic-sdk-"));
  copyFileSync(bin, join(dir, "logic-sdk.js")); // outside the repo: @logic-sdk/cli can't be resolved
  const r = spawnSync("node", [join(dir, "logic-sdk.js"), "list"], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("npm i -D @logic-sdk/cli");
});

// ── 0.2: authorize, expose: true, record checks ─────────────────────────────

const policies = fixture("policies");
const holes = fixture("holes");
const problem = (r: ReturnType<typeof cli>, code: string, file: string, line: number) =>
  r.json().problems.find((p: { code: string; at: Loc | null }) => p.code === code && p.at?.file === file && p.at.line === line);
type Loc = { file: string; line: number; column: number };

test("list and show: the policy as written (or inline) and whether it's exposed", () => {
  const rows = cli(policies, "list", "--json").json();
  expect(rows).toContainEqual(expect.objectContaining({ id: "orders.cancel", authorize: "member", exposed: true }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "orders.refund", authorize: "inline", exposed: false }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "stock.release", authorize: null, exposed: false }));
  expect(cli(policies, "list", "--exposed", "--json").json().map((r: { id: string }) => r.id)).toEqual(["orders.cancel"]);
  const text = cli(policies, "show", "orders.cancel").out;
  expect(text).toMatch(/policy\s+member/);
  expect(text).toMatch(/exposed\s+yes/);
  expect(text).not.toContain("\u2014"); // no em dashes in output
  const { nodes } = cli(policies, "graph", "--format", "json").json();
  expect(nodes).toContainEqual({ id: "orders.cancel", kind: "mutation", authorize: "member", exposed: true });
});

test("show lists record checks, in the body or through this module's helpers", () => {
  expect(cli(policies, "show", "orders.cancel", "--json").json().checks).toEqual(["canCancel"]); // via loadForCancel
  expect(cli(policies, "show", "orders.refund", "--json").json().checks).toEqual(["canRefund"]);
  expect(cli(policies, "show", "stock.release", "--json").json().checks).toEqual([]);
});

test("runs count only on ctx: ctx.run, a destructured run; never db.run. Scope changes are shown", () => {
  const cancel = cli(policies, "show", "orders.cancel", "--json").json();
  expect(cancel.runs).toEqual(["stock.release"]);
  expect(cancel.scopeChanges).toEqual([{ run: "stock.release", keys: ["accountId"] }]);
  expect(cli(policies, "show", "orders.cancel").out).toContain("stock.release (scope: accountId)");
  expect(cli(policies, "show", "orders.refund", "--json").json().runs).toEqual(["stock.release"]);
  expect(cli(policies, "check", "--json").json()).toEqual({ errors: 0, warnings: 0, problems: [] });
});

test("check: every boundary hole, both record check rules, and runs it can't name", () => {
  const r = cli(holes, "check", "--json");
  expect(r.code).toBe(1);
  expect(codes(r)).toEqual([
    "async-can",
    "async-can",
    "cross-module-import",
    "cross-module-import",
    "cross-module-import",
    "cross-module-import",
    "cross-module-import",
    "dynamic-run",
    "unused-can",
  ]);
});

test("check resolves tsconfig paths (@/) and package.json imports (#)", () => {
  const r = cli(holes, "check", "--json");
  expect(problem(r, "cross-module-import", "src/orders/mutations.ts", 2)).toMatchObject({ message: expect.stringContaining('"@/stock/data"'), fix: expect.stringContaining('from "@/stock"') });
  expect(problem(r, "cross-module-import", "src/orders/mutations.ts", 3)).toMatchObject({ message: expect.stringContaining('"#stock/data"'), fix: expect.stringContaining('from "../stock"') });
});

test("check treats re-exports and import() like imports", () => {
  const r = cli(holes, "check", "--json");
  expect(problem(r, "cross-module-import", "src/orders/mutations.ts", 8)).toBeDefined(); // export { reserved } from
  expect(problem(r, "cross-module-import", "src/orders/mutations.ts", 9)).toBeDefined(); // import("../stock/data")
});

test("check scans code outside the modules (routes, pages): only a module's index", () => {
  const p = problem(cli(holes, "check", "--json"), "cross-module-import", "src/routes/orders.ts", 3);
  expect(p.message).toContain("outside the modules");
  expect(p.fix).toContain('import * as stock from "../stock"');
});

test("check warns about runs it can't name, instead of dropping them from cycle detection", () => {
  const p = problem(cli(holes, "check", "--json"), "dynamic-run", "src/orders/mutations.ts", 20);
  expect(p).toMatchObject({ severity: "warning", message: expect.stringContaining("orders.place") });
  expect(cli(holes, "show", "orders.place", "--json").json().runs).toEqual(["(dynamic)"]); // ctx.db.run isn't one
});

test("async-can: a can* declared async, or awaited", () => {
  const r = cli(holes, "check", "--json");
  expect(problem(r, "async-can", "src/orders/rules.ts", 2)).toMatchObject({ severity: "error", message: expect.stringContaining("canShip is async") });
  expect(problem(r, "async-can", "src/orders/mutations.ts", 16)).toMatchObject({ message: expect.stringContaining("canShip is awaited") });
});

test("unused-can: a can* call whose result is thrown away", () => {
  const p = problem(cli(holes, "check", "--json"), "unused-can", "src/orders/mutations.ts", 17);
  expect(p).toMatchObject({ severity: "error", message: expect.stringContaining("canHold"), fix: expect.stringContaining("ctx.errors.deny()") });
});

// ctx.config: show lists the keys a function reads; modules never read the environment
const configApp = fixture("config");

test("show: config keys a function reads, through this module's helpers too", () => {
  expect(cli(configApp, "show", "orders.place", "--json").json().config).toEqual(["app.url", "orders.maxItems"]); // app.url via orderLink(ctx)
  expect(cli(configApp, "show", "orders.quote", "--json").json().config).toEqual(["orders.currency"]);
  expect(cli(configApp, "show", "orders.place").out).toContain("app.url, orders.maxItems");
  const keys = (id: string) => cli(configApp, "show", id, "--json").json().config;
  expect(keys("orders.aliased")).toEqual(["orders.currency", "orders.maxItems"]); // const orders = ctx.config.orders
  expect(keys("orders.destructured")).toEqual(["app.url"]); // { config: { app: { url } } }
  expect(keys("orders.methods")).toEqual(["app.url", "orders.tags"]); // not url.startsWith, not tags.length
  expect(keys("orders.whole")).toEqual(["*"]); // passed on whole: any key
  expect(cli(configApp, "show", "orders.whole").out).toContain("all of it (passed on whole)");
});

test("check: env-in-module catches process.env, import.meta.env and env reached through an import", () => {
  const r = cli(configApp, "check", "--json");
  expect(r.code).toBe(1);
  const env = r.json().problems.filter((p: { code: string }) => p.code === "env-in-module");
  expect(env.map((p: { at: { file: string; line: number } }) => `${p.at.file}:${p.at.line}`)).toEqual([
    "src/orders/mutations.ts:4", // import { linkFor } from "../lib/links", which imports ../env
    "src/stock/more.ts:2", // import { env as nodeEnv } from "node:process"
    "src/stock/more.ts:9", // process["env"]
    "src/stock/more.ts:10", // globalThis.process.env
    "src/stock/more.ts:11", // const { env } = process
    "src/stock/more.ts:13", // process2.env, from `import process2 from "node:process"`
    "src/stock/mutations.ts:9", // process.env (the type-only import on line 3 is not a read)
    "src/stock/mutations.ts:10", // import.meta.env
  ]);
  expect(env[0].message).toContain("process.env at src/env.ts:3");
  // outside the modules, env is yours to read: the entry passes process.env straight into config and services
  expect(r.json().problems.some((p: { at: { file: string } | null }) => p.at?.file === "src/server.ts")).toBe(false);
  expect(env[0].fix).toContain("ctx.config");
});

test("a module that reads the Worker's env fails to load, and the hint says why", () => {
  const r = cli(fixture("workers-env"), "check");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app-load-failed");
  expect(r.err).toContain('src/links/index.ts:1 reads the environment (env from "cloudflare:workers")');
  expect(r.err).toContain("ctx.config");
});

test("crons: list shows the schedule and what it runs; show too; the function lists the cron as its caller", () => {
  const shop = fileURLToPath(new URL("../../../examples/shop", import.meta.url));
  expect(cli(shop, "list", "--kind", "cron", "--json").json()).toEqual([
    expect.objectContaining({ id: "orders.morningDigest", kind: "cron", schedule: "0 8 * * 1-5", timezone: "Europe/Madrid", run: "orders.sendDigest" }),
  ]);
  expect(cli(shop, "show", "orders.morningDigest").out).toContain("0 8 * * 1-5");
  expect(cli(shop, "show", "orders.sendDigest", "--json").json().calledBy).toEqual(["orders.morningDigest"]);
  expect(cli(shop, "graph").out).toMatch(/morningDigest\s+cron\s+at 0 8 \* \* 1-5/);
  expect(cli(shop, "graph", "--format", "json").json().edges).toContainEqual({ from: "orders.morningDigest", to: "orders.sendDigest", type: "runs" });
});

test("check: no .transaction() in modules, and no database client, directly or through an import", () => {
  const problems: { code: string; at: { file: string; line: number }; message: string; fix: string }[] = cli(configApp, "check", "--json").json().problems;
  const where = (code: string) => problems.filter((p) => p.code === code).map((p) => `${p.at.file}:${p.at.line}`);
  expect(where("nested-transaction")).toEqual([
    "src/stock/writes.ts:6", // db.transaction(...)
    "src/stock/writes.ts:2", // import { attempt } from "../lib/savepoint", which calls db.transaction
  ]);
  expect(where("db-client-in-module")).toEqual(["src/stock/writes.ts:3"]); // import { connect } from "../db"; the type-only import on line 1 is fine
  const client = problems.find((p) => p.code === "db-client-in-module")!;
  expect(client.message).toContain('drizzle() from "drizzle-orm/node-postgres" at src/db.ts:3');
  expect(client.fix).toContain("ctx.db");
  expect(problems.find((p) => p.code === "nested-transaction")!.fix).toContain("ctx.run another mutation");
});
