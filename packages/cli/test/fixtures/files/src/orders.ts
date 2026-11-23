// A whole module in one file: query, mutation, event and listener.
import { z } from "zod";
import { event, mutation, listener, query } from "./init";
import * as stock from "./stock";

// An explicit id: what jobs store, so the export can be renamed
export const placed = event({ id: "created", payload: z.object({ sku: z.string() }) });

/** How many orders */
export const count = query({
  input: z.object({}),
  handler: async ({ db }) => db.rows.length,
});

/** Place an order */
export const place = mutation({
  input: z.object({ sku: z.string() }),
  async handler({ run, emit }, { sku }) {
    emit(placed, { sku });
    return run(stock.reserve, { sku });
  },
});

/** Reacts to placed */
export const notify = listener({ id: "email", event: () => placed, when: () => true, handler: async () => {} });
