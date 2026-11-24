import { action, mutation } from "../init";
import { record } from "./data";

/** Confirm a booking */
export const confirm = mutation({ handler: async () => 1 });

/** Take the payment */
export const pay = action({
  handler: async (ctx) => {
    await ctx.run(record);
    await ctx.run(confirm);
  },
});
