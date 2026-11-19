import { eq } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { visits } from "./schema";

export const get = query({
  description: "How many times a link was visited",
  inputSchema: z.object({ slug: z.string() }),
  expose: "signedIn",
  outputSchema: z.object({ slug: z.string(), visits: z.number() }),
  async execute({ slug }, { db }) {
    const [row] = await db.select().from(visits).where(eq(visits.slug, slug));
    return { slug, visits: row?.count ?? 0 };
  },
});
