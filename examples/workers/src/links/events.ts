import { z } from "zod";
import { event } from "../logic";

export const created = event({
  schema: z.object({ slug: z.string(), url: z.string(), createdBy: z.string() }),
});

export const visited = event({
  schema: z.object({ slug: z.string() }),
});
