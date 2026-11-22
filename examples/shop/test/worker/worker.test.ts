import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import worker from "../../src/worker";

/** Sends a request to the Worker and waits for what waitUntil kept alive (the receipt), like the runtime does. */
async function send(path: string, init: { body?: unknown; user?: string } = {}) {
  const request = new Request(`http://shop.test${path}`, {
    method: init.body ? "POST" : "GET",
    body: init.body ? JSON.stringify(init.body) : undefined,
    headers: { "content-type": "application/json", ...(init.user ? { "x-user": init.user } : {}) },
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

test("the same shop runs on Workers, through Hyperdrive", async () => {
  const products = await send("/products");
  expect(products.status).toBe(200);
  expect(await products.json()).toHaveLength(3);

  const placed = await send("/orders", { body: { items: [{ sku: "mug", quantity: 1 }] }, user: "ana" });
  expect(placed.status).toBe(201);
  expect(await placed.json()).toMatchObject({ customerId: "ana", total: 1200, status: "placed" });
});

test("settings come from the Worker's vars: MAX_ITEMS is 10 in wrangler.jsonc", async () => {
  const tooMany = await send("/orders", { body: { items: [{ sku: "mug", quantity: 11 }] }, user: "ana" });
  expect(tooMany.status).toBe(422);
  expect(await tooMany.json()).toMatchObject({ error: { code: "orders.too_many_items" } });
});

test("the receipt goes through the queue: outbox, Cloudflare Queues, the Worker's consumer", async () => {
  const log = vi.spyOn(console, "log");

  const placed = await send("/orders", { body: { items: [{ sku: "tee", quantity: 1 }] }, user: "leo" });
  expect(placed.status).toBe(201);

  // the queue hands it over within a second or two (max_batch_timeout), and the demo mailer logs it
  await vi.waitFor(
    () => expect(log).toHaveBeenCalledWith("[mail]", expect.objectContaining({ to: "leo", idempotencyKey: expect.stringMatching(/^receipt:/) })),
    { timeout: 15_000, interval: 250 },
  );
  log.mockRestore();
});
