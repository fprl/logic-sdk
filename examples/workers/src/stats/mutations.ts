import { sql } from "drizzle-orm";
import { z } from "zod";
import { mutation } from "../logic";
import { visits } from "./schema";

export const record = mutation({
  description: "Count one visit",
  inputSchema: z.object({ slug: z.string() }),
  async execute({ slug }, { db }) {
    await db
      .insert(visits)
      .values({ slug, count: 1 })
      .onConflictDoUpdate({ target: visits.slug, set: { count: sql`${visits.count} + 1` } });
  },
});
