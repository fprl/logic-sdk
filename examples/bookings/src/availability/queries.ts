import { z } from "zod";
import { query } from "../logic";
import { anyone } from "../policies";
import { overlapping } from "./data";

export const Range = z
  .object({ propertyId: z.uuid(), from: z.iso.date(), to: z.iso.date() })
  .refine((r) => r.from < r.to, { message: "from must be before to", path: ["to"] });

/** Is a property free for a date range? Check-out day is free for the next check-in. */
export const check = query({
  input: Range,
  authorize: anyone,
  output: z.object({ available: z.boolean() }),
  async handler(ctx, input) {
    const { propertyId, from, to } = input;
    const clashes = await overlapping(ctx, propertyId, from, to);
    return { available: clashes.length === 0 };
  },
});
