import { createTestRegistry } from "logic-sdk/testing";
import { beforeEach, expect, test } from "vitest";
import * as catalog from "../src/catalog";
import { createApi } from "../src/http";
import * as orders from "../src/orders";
import { ana, guest, leo, memoryMailer, sam, shop } from "./setup";

const mailer = memoryMailer();
const t = createTestRegistry(shop, { services: { mailer }, now: "2026-12-01T10:00:00Z" });
beforeEach(() => void (mailer.sent.length = 0));

const mug = (quantity = 1) => ({ items: [{ sku: "mug", quantity }] });

test("ana pays catalog prices, stock goes down, and the receipt goes out after commit", () =>
  t.transaction(async (tx) => {
    const order = await tx.as(ana).run(orders.place, {
      items: [{ sku: "mug", quantity: 2 }, { sku: "tee", quantity: 1 }],
    });

    expect(order.total).toBe(2 * 12_00 + 25_00);
    expect(order.items[0]).toEqual({ sku: "mug", name: "Logic mug", price: 12_00, quantity: 2 });
    expect(await stock(tx, "mug")).toBe(8);
    expect(mailer.sent).toEqual([
      { to: "ana", subject: "Thanks for your order (€49.00)", text: `Order ${order.id} is placed. See your orders at https://shop.test` },
    ]);
  }));

test("one item short: the whole order fails, nothing is taken, nothing is emailed", () =>
  t.transaction(async (tx) => {
    const error = await tx
      .as(ana)
      .run(orders.place, { items: [{ sku: "mug", quantity: 1 }, { sku: "poster", quantity: 2 }] })
      .catch((e) => e);

    expect(error).toMatchObject({ kind: "conflict", code: "catalog.out_of_stock", details: { sku: "poster" } });
    expect(await stock(tx, "mug")).toBe(10); // reserved first, rolled back with the rest
    expect(mailer.sent).toEqual([]);
  }));

test("an unknown product is a mistake, not a sold-out item", () =>
  t.transaction(async (tx) => {
    const error = await tx.as(ana).run(orders.place, { items: [{ sku: "mugg", quantity: 1 }] }).catch((e) => e);
    expect(error).toMatchObject({ kind: "rejected", code: "catalog.unknown_product" });
  }));

test("the item limit comes from config", () =>
  createTestRegistry(shop, { config: { orders: { maxItems: 2 } } }).transaction(async (tx) => {
    const error = await tx.as(ana).run(orders.place, mug(3)).catch((e) => e);
    expect(error).toMatchObject({ kind: "rejected", code: "orders.too_many_items", details: { max: 2 } });
  }));

test("customers cancel until it ships; staff can still cancel a shipped order", () =>
  t.transaction(async (tx) => {
    const { id: orderId } = await tx.as(ana).run(orders.place, mug(2));
    await tx.as(sam).run(orders.ship, { orderId });

    const denied = await tx.as(ana).run(orders.cancel, { orderId }).catch((e) => e);
    expect(denied.kind).toBe("forbidden");

    const cancelled = await tx.as(sam).run(orders.cancel, { orderId });
    expect(cancelled.status).toBe("cancelled");
    expect(await stock(tx, "mug")).toBe(10); // back in stock
  }));

test("only staff ship, and only orders still placed; a cancelled order stays cancelled", () =>
  t.transaction(async (tx) => {
    const { id: orderId } = await tx.as(ana).run(orders.place, mug());
    expect((await tx.as(ana).run(orders.ship, { orderId }).catch((e) => e)).kind).toBe("forbidden");

    await tx.as(ana).run(orders.cancel, { orderId });
    expect((await tx.as(sam).run(orders.ship, { orderId }).catch((e) => e)).code).toBe("orders.not_placed");
    expect((await tx.as(ana).run(orders.cancel, { orderId }).catch((e) => e)).code).toBe("orders.already_cancelled");
  }));

test("someone else's order doesn't exist for you", () =>
  t.transaction(async (tx) => {
    const { id: orderId } = await tx.as(ana).run(orders.place, mug());
    const error = await tx.as(leo).run(orders.cancel, { orderId }).catch((e) => e);
    expect(error.code).toBe("orders.not_found");
  }));

test("mine says what you may do with each order, by the same rule cancel checks", () =>
  t.transaction(async (tx) => {
    const shipped = await tx.as(ana).run(orders.place, mug());
    await tx.as(sam).run(orders.ship, { orderId: shipped.id });
    await tx.as(ana).run(orders.place, mug());

    const mine = await tx.as(ana).run(orders.mine);
    expect(mine.map((o) => [o.status, o.can.cancel]).sort()).toEqual([
      ["placed", true],
      ["shipped", false],
    ]);
  }));

test("over HTTP: guests browse, but sign in to order", () =>
  t.transaction(async (tx) => {
    const api = createApi(() => tx.registry);
    const post = (user?: string) =>
      api.request("/orders", {
        method: "POST",
        headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) },
        body: JSON.stringify(mug()),
      });

    expect(await (await api.request("/products")).json()).toHaveLength(3);
    expect((await post()).status).toBe(403); // `authorize: signedIn` says no
    expect((await post("ana")).status).toBe(201);
  }));

const stock = async (tx: { as: typeof shop.as }, sku: string) => {
  const products = await tx.as(guest).run(catalog.list);
  return products.find((p) => p.sku === sku)!.stock;
};
