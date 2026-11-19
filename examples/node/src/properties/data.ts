import { and, eq } from "drizzle-orm";
import type { QueryCtx } from "../logic";
import { properties } from "./schema";

export async function findProperty(ctx: QueryCtx, id: string) {
  const [p] = await ctx.db.select().from(properties).where(and(eq(properties.accountId, ctx.scope.accountId), eq(properties.id, id)));
  if (!p) throw ctx.errors.notFound(); // "properties.not_found"
  return p;
}
