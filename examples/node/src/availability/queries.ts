import { z } from "zod";
import { query } from "../logic";
import { overlapping } from "./data";

export const Range = z
  .object({ propertyId: z.uuid(), from: z.iso.date(), to: z.iso.date() })
  .refine((r) => r.from < r.to, { message: "from must be before to", path: ["to"] });

export const check = query({
  description: "Is a property free for a date range? Check-out day is free for the next check-in.",
  inputSchema: Range,
  expose: "public",
  outputSchema: z.object({ available: z.boolean() }),
  async execute({ propertyId, from, to }, ctx) {
    const clashes = await overlapping(ctx, propertyId, from, to);
    return { available: clashes.length === 0 };
  },
});
