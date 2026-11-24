import { z } from "zod";
import { mutation } from "../logic";
import { orderLink } from "./data";

/** Place an order */
export const place = mutation({
  input: z.object({ items: z.number() }),
  async handler(ctx, { items }) {
    const { config } = ctx;
    if (items > config.orders.maxItems) throw ctx.errors.reject("too_many_items");
    return { link: orderLink(ctx, "1") };
  },
});

/** Quote in the shop's currency */
export const quote = mutation({
  input: z.object({}),
  handler: async ({ config }) => ({ currency: config.orders.currency }),
});

// How show finds config keys: aliases, destructuring, methods, and config passed on whole
const render = (settings: unknown) => JSON.stringify(settings);

/** An alias of a section */
export const aliased = mutation({
  input: z.object({}),
  async handler(ctx) {
    const orders = ctx.config.orders;
    const { currency } = orders;
    return { max: orders.maxItems, currency };
  },
});

/** Destructured in the parameters */
export const destructured = mutation({
  input: z.object({}),
  handler: async ({ config: { app: { url } } }) => ({ url }),
});

/** Methods and length are not keys */
export const methods = mutation({
  input: z.object({}),
  handler: async ({ config }) => ({ secure: config.app.url.startsWith("https"), tags: config.orders.tags.length }),
});

/** Config passed on whole: any key may be read */
export const whole = mutation({
  input: z.object({}),
  handler: async (ctx) => render(ctx.config),
});
