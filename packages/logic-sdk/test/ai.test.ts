import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "bun:test";
import { z } from "zod";
import { toAITools } from "../src/ai.ts";
import { init } from "../src/index.ts";
import { memoryDatabase, type Store } from "./memory-db.ts";

type Scope = { actor: string | null };
const { query, mutation, event, on, createRegistry } = init<{
  scope: Scope;
  db: Store;
  services: { log: string[] };
  meta: { agent?: boolean };
}>()({ policies: { anyone: () => true, signedIn: (s) => s.actor !== null } });

const added = event({ schema: z.object({ name: z.string() }) });
const items = {
  added,
  add: mutation({
    description: "Add an item",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ name: z.string() }),
    expose: "signedIn",
    async execute({ name }, { db, emit, reject }) {
      if (name === "tiny") throw reject("too_short", { min: 5, got: 4 });
      if (name === "crash") throw new Error("connection refused at 10.0.0.3:5432");
      (db.rows.items ??= []).push({ name });
      emit(added, { name });
      return { name };
    },
  }),
  count: query({
    description: "Count items",
    inputSchema: z.object({}),
    outputSchema: z.number(),
    expose: "anyone",
    meta: { agent: false },
    execute: async (_, { db }) => (db.rows.items ?? []).length,
  }),
  wipe: mutation({ description: "internal", inputSchema: z.object({}), execute: async () => {} }),
};
const services = { log: [] as string[] };
const audit = { onAdded: on(() => added, async ({ name }, { services }) => { services.log.push(name); }) };

function setup() {
  const db = memoryDatabase();
  services.log.length = 0;
  return { db, registry: createRegistry({ modules: { items, audit }, database: db, services }) };
}

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

test("exposed functions become typed tools named module_function; internal ones don't", () => {
  const { registry } = setup();
  const tools = toAITools(registry, registry.as({ actor: "ana" }));
  expect(Object.keys(tools).sort()).toEqual(["items_add", "items_count"]);
  expect(tools.items_add.description).toEqual("Add an item");
  // @ts-expect-error internal functions are not tools
  void tools.items_wipe;
});

test("an agent's call runs as the caller: same transaction, events after commit", async () => {
  const { db, registry } = setup();
  const model = agentCalling("items_add", { name: "lamp" });
  const result = await generateText({
    model,
    tools: toAITools(registry, registry.as({ actor: "ana" })),
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
  await generateText({ model, tools: toAITools(registry, registry.as({ actor: null })), prompt: "Add a lamp", stopWhen: isStepCount(3) });
  expect(db.store.rows.items).toBeUndefined();
  expect(toolResultSeenBy(model)).toEqual({ type: "error-text", value: "DomainError: items.add.forbidden" });
});

test("rules the agent broke reach it with their details, so it can recover", async () => {
  const { registry } = setup();
  const model = agentCalling("items_add", { name: "tiny" });
  await generateText({ model, tools: toAITools(registry, registry.as({ actor: "ana" })), prompt: "Add tiny", stopWhen: isStepCount(3) });
  expect(toolResultSeenBy(model)).toEqual({ type: "error-text", value: 'DomainError: items.too_short {"min":5,"got":4}' });
});

test("unexpected errors never reach the model: it sees internal_error, onError gets the real one", async () => {
  const { registry } = setup();
  const reported: string[] = [];
  const model = agentCalling("items_add", { name: "crash" });
  const tools = toAITools(registry, registry.as({ actor: "ana" }), { onError: (e) => reported.push((e as Error).message) });
  await generateText({ model, tools, prompt: "Add crash", stopWhen: isStepCount(3) });
  expect(toolResultSeenBy(model)).toEqual({ type: "error-text", value: "Error: internal_error" });
  expect(reported).toEqual(["connection refused at 10.0.0.3:5432"]);
});

test("filter keeps functions away from agents, e.g. by meta", () => {
  const { registry } = setup();
  const tools = toAITools(registry, registry.as({ actor: "ana" }), { filter: (f) => f.fn.meta?.agent !== false });
  expect(Object.keys(tools)).toEqual(["items_add"]);
});
