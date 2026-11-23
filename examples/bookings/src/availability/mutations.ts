import { eq } from "drizzle-orm";
import { z } from "zod";
import { mutation } from "../logic";
import { owner } from "../policies";
import { insertHold } from "./data";
import { Range } from "./queries";
import { Hold, holds } from "./schema";

const HoldInput = Range.and(
  z.object({
    reason: z.enum(["booking", "owner_block", "maintenance", "channel_sync"]),
    sourceId: z.string(),
  }),
);

/**
 * Reserve a date range on a property's calendar
 *
 * Internal (not in src/rpc.ts): other modules call it with ctx.run.
 */
export const hold = mutation({
  input: HoldInput,
  handler: (ctx, input) => insertHold(ctx, input),
});

/** Free every date held by a source (e.g. a cancelled booking) */
export const release = mutation({
  input: z.object({ sourceId: z.string() }),
  async handler(ctx, input) {
    const freed = await ctx.db.delete(holds).where(eq(holds.sourceId, input.sourceId)).returning();
    return { released: freed.length };
  },
});

/**
 * Block dates as the owner (personal use, maintenance)
 *
 * Exposed: owners block their own calendar. Same rules as `hold`, through the same helper.
 */
export const block = mutation({
  input: Range.and(z.object({ reason: z.enum(["owner_block", "maintenance"]) })),
  authorize: owner,
  output: Hold,
  handler: (ctx, input) => insertHold(ctx, { ...input, sourceId: `${input.reason}:${ctx.scope.actor.id}` }),
});
