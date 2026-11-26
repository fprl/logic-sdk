import { Database } from "bun:sqlite";
import { is, SQL, sql } from "drizzle-orm";
import { drizzle as bunSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as nodeSqlite } from "drizzle-orm/node-sqlite";
import { getTableConfig, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { cronRunsTable, drizzleAdapter, jobsTable, type DrizzleDb } from "../../src/drizzle/sqlite.ts";
import { init, type SqlDatabase } from "../../src/index.ts";
import * as sqlite from "../../src/sqlite.ts";
import { createTestRegistry } from "../../src/testing.ts";
import { jobsTableSuite } from "../conformance/jobs-table.suite.ts";

setDefaultTimeout(30_000); // some wait for SQLite's 5 seconds on purpose

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TABLES = `${sqlite.jobsSchema} CREATE TABLE seam_items (name text NOT NULL); CREATE TABLE items (name text NOT NULL); CREATE TABLE runs (id text NOT NULL);`;

/** A new file with the tables. */
function newFile() {
  const file = join(mkdtempSync(join(tmpdir(), "logic-sdk-sqlite-")), "app.db");
  const setup = new DatabaseSync(file);
  setup.exec(TABLES);
  setup.close();
  return file;
}

const sqliteTarget = { databaseQueue: sqlite.databaseQueue, outbox: sqlite.outbox, param: "?", past: "0" };

jobsTableSuite("jobs table: Drizzle on node:sqlite", {
  ...sqliteTarget,
  async open() {
    const file = newFile();
    return { database: drizzleAdapter(() => nodeSqlite(file)), close: async () => {} };
  },
});

jobsTableSuite("jobs table: Drizzle on bun:sqlite", {
  ...sqliteTarget,
  async open() {
    const file = newFile();
    return { database: drizzleAdapter(() => bunSqlite({ client: new Database(file) })), close: async () => {} };
  },
});

jobsTableSuite("jobs table: node:sqlite, no ORM", {
  ...sqliteTarget,
  async open() {
    const db = new DatabaseSync(newFile());
    // one call at a time is all this list needs: the isolation is the Drizzle adapter's, tested below
    const database: SqlDatabase<DatabaseSync, DatabaseSync> = {
      db,
      async transaction(fn) {
        db.exec("begin immediate");
        try {
          const out = await fn(db);
          db.exec("commit");
          return out;
        } catch (e) {
          db.exec("rollback");
          throw e;
        }
      },
      query: async (on, query, params) => on.prepare(query).all(...(params as string[])) as Record<string, unknown>[],
    };
    return { database, close: async () => db.close() };
  },
});

const drivers = {
  "node:sqlite": (file: string) => nodeSqlite(file),
  "bun:sqlite": (file: string) => bunSqlite({ client: new Database(file) }),
};

for (const [driver, connect] of Object.entries(drivers)) {
  describe(`SQLite adapter on ${driver}`, () => {
    const items = sqliteTable("items", { name: text("name").notNull() });

    function setup() {
      const file = newFile();
      const open = () => connect(file);
      const admin = open();
      const database = drizzleAdapter(open);
      const define = init<{ scope: object; db: DrizzleDb<ReturnType<typeof open>> }>();
      const names = () => admin.select().from(items).all().map((row) => row.name).sort();
      return { open, admin, database, names, ...define };
    }

    test("a write that arrives after its mutation ended is refused, and never joins the next one", async () => {
      const { mutation, createRegistry, database, names } = setup();
      let late: Promise<unknown> | undefined;
      const fails = mutation({
        async handler(ctx) {
          late = (async () => {
            await sleep(30);
            await ctx.db.insert(items).values({ name: "late" });
          })();
          late.catch(() => {});
          await Promise.all([late, sleep(1).then(() => { throw new Error("no"); })]);
        },
      });
      const next = mutation({
        async handler(ctx) {
          await ctx.db.insert(items).values({ name: "next" });
          await sleep(80);
        },
      });
      const app = createRegistry({ modules: { x: { fails, next } }, database: { adapter: database } }).as({});
      await expect(app.run(fails)).rejects.toThrow("no");
      await app.run(next);
      await expect(late!).rejects.toThrow();
      expect(names()).toEqual(["next"]);
    });

    test("50 at once, every fifth failing: each is all or nothing", async () => {
      const { mutation, createRegistry, database, names } = setup();
      let n = 0;
      const add = mutation({
        async handler(ctx) {
          const i = n++;
          await ctx.db.insert(items).values({ name: `first ${i}` });
          await sleep(1);
          await ctx.db.insert(items).values({ name: `second ${i}` });
          if (i % 5 === 0) throw new Error("no");
        },
      });
      const app = createRegistry({ modules: { x: { add } }, database: { adapter: database } }).as({});
      const outcomes = await Promise.allSettled(Array.from({ length: 50 }, () => app.run(add)));
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(40);
      const kept = [...Array(50).keys()].filter((i) => i % 5);
      expect(names()).toEqual([...kept.map((i) => `first ${i}`), ...kept.map((i) => `second ${i}`)].sort());
    });

    test("a query during a mutation doesn't wait, sees only what's committed, and can't write", async () => {
      const { query, mutation, createRegistry, database } = setup();
      const writing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const add = mutation({
        async handler(ctx) {
          await ctx.db.insert(items).values({ name: "desk" });
          writing.resolve();
          await release.promise;
        },
      });
      const count = query({ handler: async (ctx) => (await ctx.db.select().from(items)).length });
      const sneaky = query({ handler: async (ctx) => ctx.db.all(sql`insert into items values ('sneaky') returning name`) });
      const app = createRegistry({ modules: { x: { add, count, sneaky } }, database: { adapter: database } }).as({});
      const adding = app.run(add);
      await writing.promise;
      expect(await app.run(count)).toBe(0); // answered while the mutation holds the lock
      await expect(app.run(sneaky)).rejects.toThrow();
      release.resolve();
      await adding;
      expect(await app.run(count)).toBe(1);
    });

    test("another connection holding the lock is waited for with the event loop free", async () => {
      const { mutation, createRegistry, database, open, names } = setup();
      const other = open();
      other.run(sql`begin immediate`);
      setTimeout(() => other.run(sql`commit`), 300); // only fires if the wait isn't inside SQLite
      const add = mutation({ async handler(ctx) { await ctx.db.insert(items).values({ name: "waited" }); } });
      await createRegistry({ modules: { x: { add } }, database: { adapter: database } }).as({}).run(add);
      expect(names()).toEqual(["waited"]);
    });

    test("a failure SQLite rolls back by itself is the error the caller gets", async () => {
      const { mutation, createRegistry, database, admin, names } = setup();
      admin.run(sql`create trigger no_bad before insert on items when new.name = 'bad' begin select raise(rollback, 'bad name'); end`);
      const add = mutation({
        async handler(ctx) {
          await ctx.db.insert(items).values({ name: "first" });
          await ctx.db.insert(items).values({ name: "bad" });
        },
      });
      const error: any = await createRegistry({ modules: { x: { add } }, database: { adapter: database } }).as({}).run(add).catch((e) => e);
      expect(String(error.cause?.message ?? error.message)).toContain("bad name");
      expect(names()).toEqual([]);
    });

    test("the test registry: a failing mutation undoes its own writes, rollback undoes the test", async () => {
      const { query, mutation, createRegistry, database, names } = setup();
      const add = mutation({ async handler(ctx) { await ctx.db.insert(items).values({ name: "desk" }); } });
      const fails = mutation({
        async handler(ctx) {
          await ctx.db.insert(items).values({ name: "no" });
          throw new Error("no");
        },
      });
      const list = query({ handler: async (ctx) => (await ctx.db.select().from(items)).map((row) => row.name) });
      const t = createTestRegistry(createRegistry({ modules: { x: { add, fails, list } }, database: { adapter: database } }));
      await t.begin();
      await t.as({}).run(add);
      await expect(t.as({}).run(fails)).rejects.toThrow("no");
      expect(await t.as({}).run(list)).toEqual(["desk"]);
      await t.rollback();
      expect(names()).toEqual([]);
    });

    test("what can't work is refused at startup: in memory, or the same connection twice", () => {
      expect(() => drizzleAdapter(() => connect(":memory:"))).toThrow(/on a disk/);
      const db = connect(newFile());
      expect(() => drizzleAdapter(() => db)).toThrow(/opens a new connection each time/);
    });
  });
}

test("a new Drizzle database over one client is the same connection: refused", () => {
  const client = new DatabaseSync(newFile());
  expect(() => drizzleAdapter(() => nodeSqlite({ client }))).toThrow(/opens a new connection each time/);
});

describe("SQLite: waiting for the writer", () => {
  function setup() {
    const file = newFile();
    const open = () => nodeSqlite(file);
    return { open, database: drizzleAdapter(open), ...init<{ scope: object; db: DrizzleDb<ReturnType<typeof open>> }>() };
  }

  test("a line that moves is waited for, however long", async () => {
    const { mutation, createRegistry, database } = setup();
    const slow = mutation({ async handler() { await sleep(80); } });
    const app = createRegistry({ modules: { x: { slow } }, database: { adapter: database } }).as({});
    await Promise.all(Array.from({ length: 75 }, () => app.run(slow))); // 6 seconds in all
  });

  test("another process's lock doesn't count against the transaction ahead", async () => {
    const { mutation, createRegistry, database, open } = setup();
    const other = open();
    other.run(sql`begin immediate`);
    setTimeout(() => other.run(sql`commit`), 4000);
    const slow = mutation({ async handler() { await sleep(1500); } });
    const app = createRegistry({ modules: { x: { slow } }, database: { adapter: database } }).as({});
    await Promise.all([app.run(slow), app.run(slow)]); // the second waits 5.5 seconds, 1.5 of them for a transaction here
  });

  test("a mutation waiting for a call behind it fails after 5 seconds instead of hanging", async () => {
    const { mutation, createRegistry, database } = setup();
    const inner = mutation({ async handler() {} });
    const outer = mutation({ handler: async (): Promise<void> => void (await app.run(inner)) });
    const app = createRegistry({ modules: { x: { inner, outer } }, database: { adapter: database } }).as({});
    await expect(app.run(outer)).rejects.toThrow(/Waited 5 seconds.*instead of ctx\.run/);
  });
});

describe("SQLite: processes on one file (Node)", () => {
  const script = fileURLToPath(new URL("../support/sqlite-process.ts", import.meta.url));
  const node = (...args: string[]) =>
    spawn("node", ["--experimental-strip-types", "--no-warnings", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const finished = (...args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = node(...args);
      let out = "";
      let err = "";
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (err += data));
      child.on("close", (code) => resolve({ code, out, err }));
    });

  test("six start together on a new file and commit 150; six sweep at once and each job runs once", async () => {
    const file = newFile();
    const together = (mode: string) => {
      const at = String(Date.now() + 1500);
      return Promise.all(Array.from({ length: 6 }, () => finished(mode, file, at)));
    };
    for (const { code, err } of await together("enqueue")) expect({ code, err }).toEqual({ code: 0, err: "" });

    const db = new DatabaseSync(file);
    expect(db.prepare("select count(*) as n from logic_jobs").get()).toMatchObject({ n: 150 });
    db.exec("update logic_jobs set available_at = 0");

    const sweeps = await together("sweep");
    for (const { code, err } of sweeps) expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(sweeps.reduce((sum, { out }) => sum + Number(out), 0)).toBe(150);
    expect(db.prepare("select count(*) as n, count(distinct id) as ids from runs").get()).toMatchObject({ n: 150, ids: 150 });
    db.close();
  });

  test("killed mid-mutation: nothing persists, and the next one commits", async () => {
    const file = newFile();
    const child = node("die", file);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGKILL");
    await closed;
    const open = () => nodeSqlite(file);
    const { mutation, createRegistry } = init<{ scope: object; db: DrizzleDb<ReturnType<typeof open>> }>();
    const next = mutation({ async handler(ctx) { ctx.db.run(sql`insert into items values ('next')`); } });
    await createRegistry({ modules: { x: { next } }, database: { adapter: drizzleAdapter(open) } }).as({}).run(next);
    expect(open().all(sql`select name from items`)).toEqual([{ name: "next" }]);
  });
});

/** SQLite drops an expression's outer brackets. */
const bare = (expression: string) => expression.replace(/^\((.*)\)$/, "$1");

/** A Drizzle column's default, as SQLite reports it. */
function defaultInSql(value: unknown) {
  if (value === undefined) return null;
  if (is(value, SQL)) return bare(new SQLiteDialect().sqlToQuery(value).sql);
  return typeof value === "string" ? `'${value}'` : String(value);
}

test("SQLite's jobsSchema is the table Drizzle users re-export", () => {
  const db = new DatabaseSync(newFile());
  for (const table of [jobsTable, cronRunsTable]) {
    const { name, columns, indexes } = getTableConfig(table);
    const real = db.prepare(`pragma table_info(${name})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[];
    expect(real.map((c) => ({ name: c.name, type: c.type.toLowerCase(), required: c.notnull === 1, default: c.dflt_value && bare(c.dflt_value) }))).toEqual(
      columns.map((c) => ({ name: c.name, type: c.getSQLType(), required: c.notNull, default: defaultInSql(c.default) })),
    );
    const made = db.prepare("select name from sqlite_master where type = 'index' and tbl_name = ? and sql is not null order by name").all(name) as { name: string }[];
    expect(made.map((i) => i.name)).toEqual(indexes.map((i) => i.config.name).sort());
  }
  db.close();
});
