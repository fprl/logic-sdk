// A whole module in one file: query, mutation, event and listener.
import { z } from "zod";
import { event, mutation, on, query } from "./init";
import * as stock from "./stock";

export const placed = event({ payload: z.object({ sku: z.string() }) });

export const count = query({
  description: "How many orders",
  input: z.object({}),
  handler: async ({ db }) => db.rows.length,
});

export const place = mutation({
  description: "Place an order",
  input: z.object({ sku: z.string() }),
  async handler({ run, emit }, { sku }) {
    emit(placed, { sku });
    return run(stock.reserve, { sku });
  },
});

export const notify = on(() => placed, async () => {});
