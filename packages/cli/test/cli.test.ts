import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// The real entry point: the `logic-sdk` command from the main package, which loads this CLI.
const bin = fileURLToPath(new URL("../../logic-sdk/bin/logic-sdk.js", import.meta.url));
const app = fileURLToPath(new URL("../../../examples/bookings", import.meta.url));

/** Runs the built CLI with Node, piped, the way a script or an agent would. */
function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

test("list: every function and listener, with kind and policy", () => {
  const rows = cli(app, "list", "--json").json();
  expect(rows).toContainEqual(expect.objectContaining({ id: "bookings.confirm", kind: "mutation", authorize: "staff" }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "availability.hold", kind: "mutation", authorize: null }));
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

test("list filters by module and kind", () => {
  const ids = cli(app, "list", "--module", "bookings", "--kind", "mutation", "--json").json().map((r: { id: string }) => r.id);
  expect(ids.sort()).toEqual(["bookings.(private) confirmPaid", "bookings.cancel", "bookings.confirm", "bookings.request"]);
});

test("show: schemas from the registry, edges from the source (through this module's helpers too)", () => {
  const fn = cli(app, "show", "bookings.confirm", "--json").json();
  expect(fn.input.properties.bookingId).toMatchObject({ type: "string", format: "uuid" });
  expect(fn.output.properties).not.toHaveProperty("accountId");
  expect(fn.runs).toEqual(["availability.hold"]); // in confirmBooking(ctx, id), a data.ts helper
  expect(fn.emits).toEqual(["bookings.confirmed"]);
  expect(fn.calledBy).toEqual([]);
  expect(cli(app, "show", "bookings.(private) confirmPaid", "--json").json()).toMatchObject({ private: true, calledBy: ["bookings.checkout"] });
  expect(fn.at).toMatchObject({ file: "src/bookings/mutations.ts" });
});

test("show an event: who emits it and who listens", () => {
  expect(cli(app, "show", "bookings.confirmed", "--json").json()).toEqual({
    id: "bookings.confirmed",
    module: "bookings",
    name: "confirmed",
    emittedBy: ["bookings.confirm", "bookings.(private) confirmPaid"],
    listeners: ["enquiries.winOnBooking", "tasks.prepareStay"],
  });
});

test("graph: runs, emits and triggers, as JSON or Mermaid", () => {
  const { edges } = cli(app, "graph", "--format", "json").json();
  expect(edges).toContainEqual({ from: "bookings.checkout", to: "bookings.(private) confirmPaid", type: "runs" });
  expect(edges).toContainEqual({ from: "bookings.confirm", to: "bookings.confirmed", type: "emits" });
  expect(edges).toContainEqual({ from: "bookings.confirmed", to: "tasks.prepareStay", type: "triggers" });
  const mermaid = cli(app, "graph", "--format", "mermaid").out;
  expect(mermaid.startsWith("flowchart LR")).toBe(true);
  expect(mermaid).toContain("bookings_confirm -. bookings.confirmed .-> tasks_prepareStay");
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

test("a module can be a single file, definers can have any name, and explicit ids are what the CLI shows and links", () => {
  // found in source by export name, reported by id
  expect(cli(fixture("files"), "show", "stock.hold", "--json").json()).toMatchObject({ description: "Reserve stock", at: { file: "src/stock.ts" } });
  expect(cli(fixture("files"), "show", "orders.place", "--json").json()).toMatchObject({ runs: ["stock.hold"], emits: ["orders.created"] });
  expect(cli(fixture("files"), "show", "orders.created", "--json").json()).toMatchObject({ emittedBy: ["orders.place"], listeners: ["orders.email"] });
  expect(cli(fixture("files"), "show", "orders.email", "--json").json()).toMatchObject({ conditional: true });
  expect(cli(fixture("files"), "show", "orders.email").out).toContain("only events its condition lets through");
});

test("any layout: each module is what its entry exports, followed through re-exports and imports, renames included", () => {
  const app = fixture("layouts"); // files.ts beside files/, `export { purge as purgeStored }`, an import into stock's own file
  expect(cli(app, "show", "files.remove", "--json").json()).toMatchObject({
    at: { file: "src/files/mutations.ts" },
    runs: ["stock.reserve"],
    schedules: ["files.purgeStored"],
  });
  expect(cli(app, "show", "files.clear", "--json").json()).toMatchObject({ schedules: ["files.purgeStored"] }); // through a helper's file
  expect(cli(app, "show", "files.purgeStored", "--json").json()).toMatchObject({
    description: "Delete what's stored",
    calledBy: ["files.clear", "files.remove"],
  });
  expect(cli(app, "graph", "--module", "files").out).toContain("schedules files.purgeStored");
});

test("private functions: what no index exports, found by the definer that made it (aliases too), named as the runtime names it", () => {
  const app = fixture("layouts");
  expect(cli(app, "show", "files.upload", "--json").json().runs).toEqual(["files.(private) record", "files.tidy"]);
  const rows: { id?: string; name?: string; kind: string; private?: boolean; unregistered?: boolean }[] = cli(app, "list", "--module", "files", "--json").json();
  expect(rows).toContainEqual(expect.objectContaining({ id: "files.(private) record", kind: "mutation", private: true, calledBy: ["files.upload"] }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "files.tidy", private: true }));
  expect(rows).toContainEqual(expect.objectContaining({ name: "onStored", kind: "listener", unregistered: true }));
  expect(rows).toContainEqual(expect.objectContaining({ name: "stored", kind: "event", unregistered: true })); // unexported in its file too
  expect(cli(app, "list", "--module", "files").out).toContain("Not registered");
});

test("an app that throws while loading gets a diagnostic with the location, not a stack trace", () => {
  const r = cli(fixture("crash"), "list");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app-load-failed");
  expect(r.err).toContain("ORDERS_API_URL is not set (src/orders/index.ts:3");
  expect(r.err).not.toContain("    at ");
  expect(r.err).toContain("Fix that error first");
});

test("an app that throws something that isn't an Error still gets the diagnostic", () => {
  const r = cli(fixture("crash-string"), "list");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app-load-failed");
  expect(r.err).toContain("orders failed to load");
});

test("modules can live anywhere, and package.json can point to the registry", () => {
  const app = fixture("custom"); // registry in lib/, modules in lib/domains/
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

// ── 0.2: authorize and record checks ────────────────────────────────────────

const policies = fixture("policies");

test("list and show: the policy as written, or inline", () => {
  const rows = cli(policies, "list", "--json").json();
  expect(rows).toContainEqual(expect.objectContaining({ id: "orders.cancel", authorize: "member" }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "orders.refund", authorize: "inline" }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "stock.release", authorize: null }));
  const text = cli(policies, "show", "orders.cancel").out;
  expect(text).toMatch(/policy\s+member/);
  expect(text).not.toContain("\u2014"); // no em dashes in output
  const { nodes } = cli(policies, "graph", "--format", "json").json();
  expect(nodes).toContainEqual({ id: "orders.cancel", kind: "mutation", authorize: "member" });
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
});

// ctx.config: show lists the keys a function reads
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
