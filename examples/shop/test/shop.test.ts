import { createTestRegistry } from "logic-sdk/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as catalog from "../src/catalog";
import { createApi } from "../src/http";
import { asSystem } from "../src/logic";
import * as orders from "../src/orders";
import { ana, guest, leo, memoryMailer, sam, shop } from "./setup";

const mailer = memoryMailer();
const t = createTestRegistry(shop, { services: { mailer }, now: "2026-12-01T10:00:00Z" });
beforeEach(async () => {
  mailer.sent.length = 0;
  await t.begin();
});
afterEach(() => t.rollback());

const mug = (quantity = 1) => ({ items: [{ sku: "mug", quantity }] });

test("ana pays catalog prices, stock goes down, and the receipt goes out after commit", async () => {
  const order = await t.as(ana).run(orders.place, {
    items: [{ sku: "mug", quantity: 2 }, { sku: "tee", quantity: 1 }],
  });

  expect(order.total).toBe(2 * 12_00 + 25_00);
  expect(order.items[0]).toEqual({ sku: "mug", name: "Logic mug", price: 12_00, quantity: 2 });
  expect(await stock("mug")).toBe(8);
  expect(mailer.sent).toEqual([
    { to: "ana", subject: "Thanks for your order (€49.00)", text: `Order ${order.id} is placed. See your orders at https://shop.test` },
  ]);
});

test("one item short: the whole order fails, nothing is taken, nothing is emailed", async () => {
  const error = await t
    .as(ana)
    .run(orders.place, { items: [{ sku: "mug", quantity: 1 }, { sku: "poster", quantity: 2 }] })
    .catch((e) => e);

  expect(error).toMatchObject({ kind: "conflict", code: "catalog.out_of_stock", details: { sku: "poster" } });
  expect(await stock("mug")).toBe(10); // reserved first, rolled back with the rest
  expect(mailer.sent).toEqual([]);
});

test("an unknown product is a mistake, not a sold-out item", async () => {
  const error = await t.as(ana).run(orders.place, { items: [{ sku: "mugg", quantity: 1 }] }).catch((e) => e);
  expect(error).toMatchObject({ kind: "rejected", code: "catalog.unknown_product" });
});

test("customers cancel until it ships; staff can still cancel a shipped order", async () => {
  const { id: orderId } = await t.as(ana).run(orders.place, mug(2));
  await t.as(sam).run(orders.ship, { orderId });

  const denied = await t.as(ana).run(orders.cancel, { orderId }).catch((e) => e);
  expect(denied.kind).toBe("forbidden");

  const cancelled = await t.as(sam).run(orders.cancel, { orderId });
  expect(cancelled.status).toBe("cancelled");
  expect(await stock("mug")).toBe(10); // back in stock
});

test("only staff ship, and only orders still placed; a cancelled order stays cancelled", async () => {
  const { id: orderId } = await t.as(ana).run(orders.place, mug());
  expect((await t.as(ana).run(orders.ship, { orderId }).catch((e) => e)).kind).toBe("forbidden");

  await t.as(ana).run(orders.cancel, { orderId });
  expect((await t.as(sam).run(orders.ship, { orderId }).catch((e) => e)).code).toBe("orders.not_placed");
  expect((await t.as(ana).run(orders.cancel, { orderId }).catch((e) => e)).code).toBe("orders.already_cancelled");
});

test("someone else's order doesn't exist for you", async () => {
  const { id: orderId } = await t.as(ana).run(orders.place, mug());
  const error = await t.as(leo).run(orders.cancel, { orderId }).catch((e) => e);
  expect(error.code).toBe("orders.not_found");
});

test("mine says what you may do with each order, by the same rule cancel checks", async () => {
  const shipped = await t.as(ana).run(orders.place, mug());
  await t.as(sam).run(orders.ship, { orderId: shipped.id });
  await t.as(ana).run(orders.place, mug());

  const mine = await t.as(ana).run(orders.mine);
  expect(mine.map((o) => [o.status, o.can.cancel]).sort()).toEqual([
    ["placed", true],
    ["shipped", false],
  ]);
});

test("over HTTP: guests browse, but sign in to order", async () => {
  const api = createApi(() => t.registry);
  const post = (user?: string) =>
    api.request("/orders", {
      method: "POST",
      headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) },
      body: JSON.stringify(mug()),
    });

  expect(await (await api.request("/products")).json()).toHaveLength(3);
  expect((await post()).status).toBe(403); // `authorize: signedIn` says no
  expect((await post("ana")).status).toBe(201);
});

const stock = async (sku: string) => {
  const products = await t.as(guest).run(catalog.list);
  return products.find((p) => p.sku === sku)!.stock;
};

test("weekday mornings, staff get a digest of what's waiting to ship", async () => {
  await t.as(ana).run(orders.place, mug());
  mailer.sent.length = 0;

  expect(await t.jobs.tick("2026-12-01T07:00:00Z")).toEqual(["orders.morningDigest"]); // a Tuesday, 8:00 in Madrid
  expect(mailer.sent).toEqual([{ to: "staff", subject: "1 orders to ship", text: "https://shop.test/orders" }]);
  expect(await t.jobs.tick("2026-12-05T07:00:00Z")).toEqual([]); // Saturday
});

test("the system can do only what a policy grants it: the digest, not placing orders", async () => {
  const digest = t.as(asSystem("orders.morningDigest"));
  expect(await digest.run(orders.toShip)).toBe(0);
  expect((await digest.run(orders.place, mug()).catch((e) => e)).kind).toBe("forbidden");
});
