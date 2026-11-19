import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { MutationCtx, QueryCtx } from "../logic";
import { holds } from "./schema";

export async function overlapping({ db }: QueryCtx, propertyId: string, from: string, to: string) {
  return db.select().from(holds).where(and(eq(holds.propertyId, propertyId), lt(holds.from, to), gt(holds.to, from)));
}

type NewHold = typeof holds.$inferInsert;

/** The one way dates get held: `hold` (other modules) and `block` (owners) both go through here. */
export async function insertHold(ctx: MutationCtx, input: NewHold) {
  // One hold at a time per property: a concurrent confirm waits here, then sees the committed hold below.
  // Without it, two overlapping inserts deadlock inside the exclusion constraint instead of failing cleanly.
  await ctx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${input.propertyId}))`);
  if ((await overlapping(ctx, input.propertyId, input.from, input.to)).length)
    throw ctx.errors.conflict("dates_unavailable", { from: input.from, to: input.to });
  const [h] = await ctx.db.insert(holds).values(input).returning(); // the exclusion constraint stays the final guarantee
  return h!;
}
