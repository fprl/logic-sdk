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

/** Internal (no expose): other modules call it with ctx.run. */
export const hold = mutation({
  description: "Reserve a date range on a property's calendar",
  input: HoldInput,
  handler: (ctx, input) => insertHold(ctx, input),
});

export const release = mutation({
  description: "Free every date held by a source (e.g. a cancelled booking)",
  input: z.object({ sourceId: z.string() }),
  async handler(ctx, input) {
    const freed = await ctx.db.delete(holds).where(eq(holds.sourceId, input.sourceId)).returning();
    return { released: freed.length };
  },
});

/** Exposed: owners block their own calendar. Same rules as `hold`, through the same helper. */
export const block = mutation({
  description: "Block dates as the owner (personal use, maintenance)",
  input: Range.and(z.object({ reason: z.enum(["owner_block", "maintenance"]) })),
  authorize: owner,
  expose: true,
  output: Hold,
  handler: (ctx, input) => insertHold(ctx, { ...input, sourceId: `${input.reason}:${ctx.scope.actor.id}` }),
});
