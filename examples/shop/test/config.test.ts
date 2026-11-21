import { createTestRegistry } from "logic-sdk/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as orders from "../src/orders";
import { ana, shop } from "./setup";

// A test registry with other config gets its own file: one test transaction at a time per connection.
const t = createTestRegistry(shop, { config: { orders: { maxItems: 2 } } });
beforeEach(() => t.begin());
afterEach(() => t.rollback());

test("the item limit comes from config", async () => {
  const error = await t.as(ana).run(orders.place, { items: [{ sku: "mug", quantity: 3 }] }).catch((e) => e);
  expect(error).toMatchObject({ kind: "rejected", code: "orders.too_many_items", details: { max: 2 } });
});
