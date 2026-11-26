import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "bun:test";
import { z } from "zod";
import { toAITool, type AIToolOptions, type AIMeta } from "../../src/ai.ts";
import type { Caller } from "../../src/index.ts";
import { init } from "../../src/index.ts";
import { memoryDatabase, type Store } from "../support/memory-db.ts";

type Scope = { actor: string | null };
const { query, mutation, event, listener, createRegistry } = init<{
  scope: Scope;
  db: Store;
  services: { log: string[] };
  meta: AIMeta;
}>();
const anyone = () => true;
const signedIn = (s: Scope): s is { actor: string } => s.actor !== null;

const added = event({ payload: z.object({ name: z.string() }) });
const items = {
  added,
  add: mutation({
    input: z.object({ name: z.string() }),
    output: z.object({ name: z.string() }),
    authorize: signedIn,
    meta: { ai: { description: "Add an item" } },
    async handler({ db, emit, errors }, { name }) {
      if (name === "tiny") throw errors.reject("too_short", { min: 5, got: 4 });
      if (name === "crash") throw new Error("connection refused at 10.0.0.3:5432");
      (db.rows.items ??= []).push({ name });
      emit(added, { name });
      return { name };
    },
  }),
  count: query({
    output: z.number(),
    authorize: anyone,
    handler: async ({ db }) => (db.rows.items ?? []).length,
  }),
  wipe: mutation({ input: z.object({}), handler: async () => {} }),
};
const services = { log: [] as string[] };
const audit = { onAdded: listener({ event: () => added, handler: async ({ services }, { name }) => { services.log.push(name); } }) };

function setup() {
  const db = memoryDatabase();
  services.log.length = 0;
  return { db, registry: createRegistry({ modules: { items, audit }, database: { adapter: db }, services }) };
}

/** The agent's tools: you pick and name them. */
const toolsFor = (caller: Caller<Scope>, options?: AIToolOptions) => ({ items_add: toAITool(caller, items.add, options) });

/** A scripted model: calls one tool, then answers. */
function agentCalling(toolName: string, input: unknown) {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
      { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] },
    ],
  });
}
/** What the model was told about its tool call, on its second turn. */
const toolResultSeenBy = (model: MockLanguageModelV4) =>
  (model.doGenerateCalls[1]!.prompt.at(-1) as { content: { output: unknown }[] }).content[0]!.output;

test("descriptions: the call option wins, then meta.ai.description, else none", () => {
  const { registry } = setup();
  const caller = registry.as({ actor: "ana" });
  expect(toAITool(caller, items.add, { description: "Add one thing" }).description).toEqual("Add one thing");
  expect(toAITool(caller, items.add).description).toEqual("Add an item");
  expect(toAITool(caller, items.count).description).toBeUndefined();
});

test("toAITool: one function as a tool you name; one without authorize is refused, by type and at runtime", async () => {
  const { db, registry } = setup();
  const caller = registry.as({ actor: "ana" });
  const model = agentCalling("addItem", { name: "desk" });
  await generateText({ model, tools: { addItem: toAITool(caller, items.add) }, prompt: "Add a desk", stopWhen: isStepCount(3) });
  expect(db.store.rows.items).toEqual([{ name: "desk" }]);
  // @ts-expect-error nobody said who may call it
  expect(() => toAITool(caller, items.wipe)).toThrow(/needs authorize/);
});

test("a function without input is an object tool the model calls with {}", async () => {
  const { registry } = setup();
  const model = agentCalling("countItems", {});
  await generateText({ model, tools: { countItems: toAITool(registry.as({ actor: "ana" }), items.count) }, prompt: "How many?", stopWhen: isStepCount(3) });
  expect(model.doGenerateCalls[0]!.tools?.[0]).toMatchObject({ inputSchema: { type: "object", properties: {} } });
  expect(toolResultSeenBy(model)).toEqual({ type: "json", value: 0 });
});

test("an agent's call runs as the caller: same transaction, events after commit", async () => {
  const { db, registry } = setup();
  const model = agentCalling("items_add", { name: "lamp" });
  const result = await generateText({
    model,
    tools: toolsFor(registry.as({ actor: "ana" })),
    prompt: "Add a lamp",
    stopWhen: isStepCount(3),
  });
  expect(result.text).toEqual("done");
  expect(db.store.rows.items).toEqual([{ name: "lamp" }]);
  expect(services.log).toEqual(["lamp"]);
  expect(toolResultSeenBy(model)).toEqual({ type: "json", value: { name: "lamp" } });
});

test("policies apply to agents too: a denied call reaches the model as an error", async () => {
  const { db, registry } = setup();
  const model = agentCalling("items_add", { name: "lamp" });
  await generateText({ model, tools: toolsFor(registry.as({ actor: null })), prompt: "Add a lamp", stopWhen: isStepCount(3) });
  expect(db.store.rows.items).toBeUndefined();
  expect(toolResultSeenBy(model)).toEqual({ type: "error-text", value: "DomainError: items.add.forbidden" });
});

test("rules the agent broke reach it with their details, so it can recover", async () => {
  const { registry } = setup();
  const model = agentCalling("items_add", { name: "tiny" });
  await generateText({ model, tools: toolsFor(registry.as({ actor: "ana" })), prompt: "Add tiny", stopWhen: isStepCount(3) });
  expect(toolResultSeenBy(model)).toEqual({ type: "error-text", value: 'DomainError: items.too_short {"min":5,"got":4}' });
});

test("unexpected errors never reach the model: it sees internal_error, onError gets the real one", async () => {
  const { registry } = setup();
  const reported: string[] = [];
  const model = agentCalling("items_add", { name: "crash" });
  const tools = toolsFor(registry.as({ actor: "ana" }), { onError: (e) => reported.push((e as Error).message) });
  await generateText({ model, tools, prompt: "Add crash", stopWhen: isStepCount(3) });
  expect(toolResultSeenBy(model)).toEqual({ type: "error-text", value: "Error: internal_error" });
  expect(reported).toEqual(["connection refused at 10.0.0.3:5432"]);
});

