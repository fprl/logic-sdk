import { and, eq, gt, lt } from "drizzle-orm";
import type { QueryCtx } from "../logic";
import { holds } from "./schema";

export async function overlapping({ db }: QueryCtx, propertyId: string, from: string, to: string) {
  return db.select().from(holds).where(and(eq(holds.propertyId, propertyId), lt(holds.from, to), gt(holds.to, from)));
}
