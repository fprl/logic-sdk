import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { mutation } from "../logic";
import { overlapping } from "./data";
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
  inputSchema: HoldInput,
  async execute(input, ctx) {
    // One hold at a time per property: a concurrent confirm waits here, then sees the committed hold below.
    // Without it, two overlapping inserts deadlock inside the exclusion constraint instead of failing cleanly.
    await ctx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${input.propertyId}))`);
    if ((await overlapping(ctx, input.propertyId, input.from, input.to)).length)
      throw ctx.conflict("dates_unavailable", { from: input.from, to: input.to });
    const [h] = await ctx.db.insert(holds).values(input).returning(); // the exclusion constraint stays the final guarantee
    return h!;
  },
});

export const release = mutation({
  description: "Free every date held by a source (e.g. a cancelled booking)",
  inputSchema: z.object({ sourceId: z.string() }),
  async execute({ sourceId }, { db }) {
    const freed = await db.delete(holds).where(eq(holds.sourceId, sourceId)).returning();
    return { released: freed.length };
  },
});

/** Exposed: owners block their own calendar. Same rules, via `hold`. */
export const block = mutation({
  description: "Block dates as the owner (personal use, maintenance)",
  inputSchema: Range.and(z.object({ reason: z.enum(["owner_block", "maintenance"]) })),
  expose: "owner",
  outputSchema: Hold,
  execute: (input, { run, scope }) => run(hold, { ...input, sourceId: `${input.reason}:${scope.actor.id}` }),
});
