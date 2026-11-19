// A whole module in one file: query, mutation, event and listener.
import { z } from "zod";
import { event, mutation, on, query } from "./init";
import * as stock from "./stock";

export const placed = event({ schema: z.object({ sku: z.string() }) });

export const count = query({
  description: "How many orders",
  inputSchema: z.object({}),
  execute: async (_, { db }) => db.rows.length,
});

export const place = mutation({
  description: "Place an order",
  inputSchema: z.object({ sku: z.string() }),
  async execute({ sku }, { run, emit }) {
    emit(placed, { sku });
    return run(stock.reserve, { sku });
  },
});

export const notify = on(() => placed, async () => {});
