import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// The real entry point: the `logic-sdk` command from the main package, which loads this CLI.
const bin = fileURLToPath(new URL("../../logic-sdk/bin/logic-sdk.js", import.meta.url));
const app = fileURLToPath(new URL("../../../examples/node", import.meta.url));
const broken = fileURLToPath(new URL("./fixtures/broken", import.meta.url));

/** Runs the built CLI with Node, piped, the way a script or an agent would. */
function cli(cwd: string, ...args: string[]) {
  const r = spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

test("list: every function and listener, with kind and policy", () => {
  const rows = cli(app, "list", "--json").json();
  expect(rows).toContainEqual(expect.objectContaining({ id: "bookings.confirm", kind: "mutation", expose: "staff" }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "availability.hold", kind: "mutation", expose: null }));
  expect(rows).toContainEqual(expect.objectContaining({ id: "tasks.prepareStay", kind: "listener", event: "bookings.confirmed" }));
});

test("list filters by module, kind and exposure", () => {
  const ids = cli(app, "list", "--module", "bookings", "--exposed", "--json").json().map((r: { id: string }) => r.id);
  expect(ids.sort()).toEqual(["bookings.cancel", "bookings.checkout", "bookings.confirm", "bookings.get", "bookings.request"]);
});

test("show: schemas from the registry, edges from the source", () => {
  const fn = cli(app, "show", "bookings.confirm", "--json").json();
  expect(fn.input.properties.bookingId).toMatchObject({ type: "string", format: "uuid" });
  expect(fn.output.properties).not.toHaveProperty("accountId");
  expect(fn.runs).toEqual(["availability.hold"]);
  expect(fn.emits).toEqual(["bookings.confirmed"]);
  expect(fn.calledBy).toEqual(["bookings.checkout"]);
  expect(fn.at).toMatchObject({ file: "src/bookings/mutations.ts" });
});

test("show an event: who emits it and who listens", () => {
  expect(cli(app, "show", "bookings.confirmed", "--json").json()).toEqual({
    id: "bookings.confirmed",
    emittedBy: ["bookings.confirm"],
    listeners: ["enquiries.winOnBooking", "tasks.prepareStay"],
  });
});

test("graph: runs, emits and triggers, as JSON or Mermaid", () => {
  const { edges } = cli(app, "graph", "--format", "json").json();
  expect(edges).toContainEqual({ from: "bookings.checkout", to: "bookings.confirm", type: "runs" });
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

test("a module can be a single file: queries, mutations, events and listeners in bookings.ts", () => {
  const r = cli(fixture("files"), "check", "--json");
  expect(r.json()).toEqual({ errors: 0, warnings: 0, problems: [] });
  expect(cli(fixture("files"), "show", "orders.place", "--json").json()).toMatchObject({ runs: ["stock.reserve"], emits: ["orders.placed"] });
  expect(cli(fixture("files"), "show", "orders.placed", "--json").json()).toMatchObject({ emittedBy: ["orders.place"], listeners: ["orders.notify"] });
});

test("an app that throws while loading gets a diagnostic with the location, not a stack trace", () => {
  const r = cli(fixture("crash"), "list");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app-load-failed");
  expect(r.err).toContain("ORDERS_API_URL is not set (src/orders/index.ts:3");
  expect(r.err).not.toContain("    at ");
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
