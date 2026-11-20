import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { mutation } from "../logic";
import { anyone } from "../policies";
import { Enquiry, enquiries } from "./schema";

export const create = mutation({
  description: "A guest asks about a property",
  input: z.object({ propertyId: z.uuid(), guestEmail: z.email(), message: z.string().min(1) }),
  authorize: anyone,
  expose: true,
  output: Enquiry,
  async handler(ctx, input) {
    const [e] = await ctx.db.insert(enquiries).values({ ...input, accountId: ctx.scope.accountId }).returning();
    return e!;
  },
});

export const markWon = mutation({
  description: "An enquiry turned into a confirmed booking",
  input: z.object({ enquiryId: z.uuid() }),
  async handler(ctx, input) {
    await ctx.db
      .update(enquiries)
      .set({ status: "won" })
      .where(and(eq(enquiries.id, input.enquiryId), eq(enquiries.accountId, ctx.scope.accountId)));
  },
});
