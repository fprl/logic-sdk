// A listener's key, unique and timeout, as the core runs them (inProcess() and any adapter). The jobs table's side runs
// in conformance/jobs-table.suite.ts on every database.
import { z } from "zod";
import { expect, test } from "bun:test";
import { init, type FailureInfo, type Job } from "../../src/index.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

const { mutation, event, listener, createRegistry } = init<{ scope: { who: string }; db: Store }>();

/** Resolves once `ready()` holds: for a job that's started in another request. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ready()).toBe(true);
}

/** A promise a test opens by hand: a job that's still running. */
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => (open = resolve));
  return { closed, open };
}

const said = event({ payload: z.object({ conversation: z.string(), text: z.string() }) });
const say = mutation({ input: said.payload, async handler(ctx, message) { ctx.emit(said, message); } });

test("key: jobs with the same key run one at a time, in order; another key doesn't wait", async () => {
  const ran: string[] = [];
  const hi = gate();
  const reply = listener({
    event: () => said,
    key: (m) => m.conversation,
    async handler(_ctx, { text }) {
      ran.push(`start ${text}`);
      if (text === "hi") await hi.closed;
      ran.push(`end ${text}`);
    },
  });
  const app = createRegistry({ modules: { chat: { said, say, reply } }, database: { adapter: memoryDatabase() } }).as({ who: "ana" });

  const first = app.run(say, { conversation: "c1", text: "hi" });
  await until(() => ran.includes("start hi"));
  const second = app.run(say, { conversation: "c1", text: "there" }); // committed: its job waits for "hi"
  await app.run(say, { conversation: "c2", text: "yo" });
  expect(ran).toEqual(["start hi", "start yo", "end yo"]);
  hi.open();
  await Promise.all([first, second]);
  expect(ran).toEqual(["start hi", "start yo", "end yo", "end hi", "start there", "end there"]);
});

test("key: refused at startup by an adapter that can't run jobs in order", () => {
  const reply = listener({ event: () => said, key: (m) => m.conversation, async handler() {} });
  const queue = { name: "aQueue()", async deliver() {} };
  expect(() => createRegistry({ modules: { chat: { said, say, reply } }, database: { adapter: memoryDatabase() }, jobs: { adapter: queue, scope: { load: (s) => s } } })).toThrow(
    "[logic-sdk] chat.reply has a key, but your jobs adapter, aQueue(), can't run jobs one at a time by key.",
  );
});

test("key and unique on one listener are refused: key runs every job in order, unique drops some", () => {
  expect(() => listener({ event: () => said, key: (m) => m.conversation, unique: (m) => m.text, async handler() {} })).toThrow(
    "[logic-sdk] a listener takes key or unique, not both: key runs every job in order, unique drops the ones waiting.",
  );
});

test("key and unique values are checked at commit: a throw or an empty one fails the mutation", async () => {
  const reply = listener({ event: () => said, key: (m) => m.text, async handler() {} });
  const count = listener({ event: () => said, unique: (m) => { if (m.text === "boom") throw new Error("no value"); return m.conversation; }, async handler() {} });
  const app = createRegistry({ modules: { chat: { said, say, reply, count } }, database: { adapter: memoryDatabase() } }).as({ who: "ana" });
  await expect(app.run(say, { conversation: "c1", text: "" })).rejects.toThrow('chat.reply\'s key must return a non-empty string (got "") on chat.said.');
  await expect(app.run(say, { conversation: "c1", text: "boom" })).rejects.toThrow("chat.count's unique threw on chat.said: no value");
});

const changed = event({ payload: z.object({ product: z.string() }) });
const restock = mutation({
  input: z.object({ products: z.array(z.string()) }),
  async handler(ctx, { products }) {
    for (const product of products) ctx.emit(changed, { product });
  },
});

test("unique: within one commit, the first job per value is kept and the rest dropped", async () => {
  const jobs: Job[] = [];
  const reindex = listener({ event: () => changed, unique: (p) => p.product, async handler() {} });
  const app = createRegistry({
    modules: { shop: { changed, restock, reindex } },
    database: { adapter: memoryDatabase() },
    jobs: { adapter: { replaces: true, async deliver(batch) { jobs.push(...batch); } }, scope: { load: (s) => s } },
  }).as({ who: "ana" });
  await app.run(restock, { products: ["p1", "p2", "p1", "p1"] });
  expect(jobs.map((j) => j.kind === "delivery" && [j.envelope.payload, j.unique])).toEqual([
    [{ product: "p1" }, "shop.reindex@p1"],
    [{ product: "p2" }, "shop.reindex@p2"],
  ]);
});

test("unique: refused at startup by an adapter that holds jobs but can't drop one it has", () => {
  const reindex = listener({ event: () => changed, unique: (p) => p.product, async handler() {} });
  const queue = { name: "aQueue()", holds: true as const, async deliver() {} };
  expect(() => createRegistry({ modules: { shop: { changed, restock, reindex } }, database: { adapter: memoryDatabase() }, jobs: { adapter: queue, scope: { load: (s) => s } } })).toThrow(
    "[logic-sdk] shop.reindex is unique, but your jobs adapter, aQueue(), can't drop a job it already has.",
  );
});

test("timeout: the try is stopped, ctx.signal aborts and no new ctx.run starts; with tries left it's retried", async () => {
  const seen: string[] = [];
  const failures: FailureInfo[] = [];
  const note = mutation({ async handler() { seen.push("note ran"); } });
  const slow = listener({
    event: () => said,
    attempts: 2,
    timeout: 0.05,
    async handler(ctx) {
      await new Promise((resolve) => ctx.signal?.addEventListener("abort", resolve));
      seen.push(`aborted: ${ctx.signal?.aborted}`);
      await ctx.run(note).catch((e: Error) => seen.push(e.message));
    },
  });
  const queued: Job[] = [];
  const registry = createRegistry({
    modules: { chat: { said, say, slow, note } },
    database: { adapter: memoryDatabase() },
    jobs: { adapter: { retries: true, async deliver(jobs) { queued.push(...jobs); } }, scope: { load: (s) => s } },
    onError: (_e, info) => void failures.push(info),
  });
  await registry.as({ who: "ana" }).run(say, { conversation: "c1", text: "hi" });
  const [job] = queued;

  const why = "[logic-sdk] chat.slow ran past its timeout of 0.05s, so this try was stopped.";
  await expect(registry.jobs.run(job!, { attempt: 1 })).rejects.toThrow(why); // a try is left: retry
  await until(() => seen.length === 2);
  expect(seen).toEqual(["aborted: true", why]);
  expect(await registry.jobs.run(job!, { attempt: 2 })).toBe("failed"); // the last try
  expect(failures.map((f) => [f.source, f.outcome])).toEqual([["chat.slow", "retry"], ["chat.slow", "failed"]]);
});

test("timeout: what a stopped try still commits is delivered, not lost with the try", async () => {
  const seen: string[] = [];
  const late = gate();
  const noted = event({ payload: z.object({ text: z.string() }) });
  const note = mutation({ async handler(ctx) { await late.closed; ctx.emit(noted, { text: "late" }); } });
  const slow = listener({ event: () => said, timeout: 0.05, async handler(ctx) { await ctx.run(note); } });
  const echo = listener({ event: () => noted, async handler(_ctx, { text }) { seen.push(text); } });
  const app = createRegistry({ modules: { chat: { said, say, slow, note, noted, echo } }, database: { adapter: memoryDatabase() }, onError: () => {} }).as({ who: "ana" });
  await app.run(say, { conversation: "c1", text: "hi" }); // the try is stopped while note runs
  late.open(); // note commits after the timeout
  await until(() => seen.length === 1);
  expect(seen).toEqual(["late"]);
});
