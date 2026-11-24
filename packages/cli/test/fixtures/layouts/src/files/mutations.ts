import { z } from "zod";
import { mutation } from "../init";
import { hold } from "../stock/mutations";
import { purge } from "./actions";
import { purgeLater } from "./later";
import { log } from "../shared/audit";

/** Remove a file's record */
export const remove = mutation({
  input: z.object({ fileId: z.string() }),
  async handler(ctx, { fileId }) {
    await ctx.run(hold, { sku: fileId });
    ctx.schedule(purge, { key: fileId }, { delay: 0 });
  },
});

/** Remove every file */
export const clear = mutation({
  input: z.object({}),
  async handler(ctx) {
    await ctx.run(log);
    purgeLater(ctx, "all");
  },
});
