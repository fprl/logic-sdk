import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { query, signedIn } from "../logic";
import { canCancel } from "./data";
import { Order, orders } from "./schema";

export const mine = query({
  description: "Your own orders, newest first, with what you may do with each",
  inputSchema: z.undefined(),
  authorize: signedIn,
  expose: true,
  outputSchema: z.array(Order.extend({ can: z.object({ cancel: z.boolean() }) })),
  async execute(_, { db, scope }) {
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.customerId, scope.user.id))
      .orderBy(desc(orders.createdAt));
    // The same rule cancel checks, so the UI shows the button only when it would work
    return rows.map((order) => ({ ...order, can: { cancel: canCancel(scope.user, order) } }));
  },
});
