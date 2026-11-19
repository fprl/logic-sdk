import { eq } from "drizzle-orm";
import { z } from "zod";
import { anyone, mutation, signedIn } from "../logic";
import { created, visited } from "./events";
import { Link, links } from "./schema";

export const create = mutation({
  description: "Shorten a URL. Pick a slug or get a random one.",
  inputSchema: z.object({ url: z.url(), slug: z.string().regex(/^[a-z0-9-]{2,32}$/).optional() }),
  authorize: signedIn,
  expose: true,
  outputSchema: Link,
  async execute({ url, slug }, { db, scope, emit, errors }) {
    const [link] = await db
      .insert(links)
      .values({ slug: slug ?? crypto.randomUUID().slice(0, 8), url, createdBy: scope.user })
      .onConflictDoNothing()
      .returning();
    if (!link) throw errors.conflict("slug_taken", { slug });

    emit(created, { slug: link.slug, url: link.url, createdBy: link.createdBy });
    return link;
  },
});

export const visit = mutation({
  description: "Resolve a slug for a redirect and record the visit",
  inputSchema: z.object({ slug: z.string() }),
  authorize: anyone,
  expose: true,
  outputSchema: z.object({ url: z.string() }),
  async execute({ slug }, { db, emit, errors }) {
    const [link] = await db.select().from(links).where(eq(links.slug, slug));
    if (!link) throw errors.notFound(); // "links.not_found"
    emit(visited, { slug }); // stats counts it after commit, after the redirect is sent
    return { url: link.url };
  },
});
