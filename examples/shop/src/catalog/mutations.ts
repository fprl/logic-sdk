import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { mutation } from "../logic";
import { products } from "./schema";

const Items = z.object({
  items: z.array(z.object({ sku: z.string(), quantity: z.int().min(1) })).min(1),
});

/** Internal: orders runs it. Takes stock at catalog prices, or fails on the first item that's short. */
export const reserve = mutation({
  description: "Take items out of stock and price them",
  input: Items,
  async handler(ctx, input) {
    const lines = [];
    for (const { sku, quantity } of input.items) {
      // The check and the write are one statement, so two buyers can't both take the last one
      const [product] = await ctx.db
        .update(products)
        .set({ stock: sql`${products.stock} - ${quantity}` })
        .where(and(eq(products.sku, sku), gte(products.stock, quantity)))
        .returning();
      if (!product) {
        const [known] = await ctx.db.select().from(products).where(eq(products.sku, sku));
        throw known ? ctx.errors.conflict("out_of_stock", { sku }) : ctx.errors.reject("unknown_product", { sku });
      }
      lines.push({ sku, name: product.name, price: product.price, quantity });
    }
    return lines;
  },
});

/** Internal: put items back, when an order is cancelled. */
export const release = mutation({
  description: "Put items back in stock",
  input: Items,
  async handler(ctx, input) {
    for (const { sku, quantity } of input.items)
      await ctx.db
        .update(products)
        .set({ stock: sql`${products.stock} + ${quantity}` })
        .where(eq(products.sku, sku));
  },
});
