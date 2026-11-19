import { z } from "zod";
import { mutation } from "../logic";
import { orderLink } from "./data";
import { linkFor } from "../lib/links"; // reads env through ../env: flagged

export const place = mutation({
  description: "Place an order",
  inputSchema: z.object({ items: z.number() }),
  async execute({ items }, ctx) {
    const { config } = ctx;
    if (items > config.orders.maxItems) throw ctx.errors.reject("too_many_items");
    return { link: orderLink(ctx, "1"), legacy: linkFor("1") };
  },
});

export const quote = mutation({
  description: "Quote in the shop's currency",
  inputSchema: z.object({}),
  execute: async (_, { config }) => ({ currency: config.orders.currency }),
});

// How show finds config keys: aliases, destructuring, methods, and config passed on whole
const render = (settings: unknown) => JSON.stringify(settings);

export const aliased = mutation({
  description: "An alias of a section",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    const orders = ctx.config.orders;
    const { currency } = orders;
    return { max: orders.maxItems, currency };
  },
});

export const destructured = mutation({
  description: "Destructured in the parameters",
  inputSchema: z.object({}),
  execute: async (_, { config: { app: { url } } }) => ({ url }),
});

export const methods = mutation({
  description: "Methods and length are not keys",
  inputSchema: z.object({}),
  execute: async (_, { config }) => ({ secure: config.app.url.startsWith("https"), tags: config.orders.tags.length }),
});

export const whole = mutation({
  description: "Config passed on whole: any key may be read",
  inputSchema: z.object({}),
  execute: async (_, ctx) => render(ctx.config),
});
