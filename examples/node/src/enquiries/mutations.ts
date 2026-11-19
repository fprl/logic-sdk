import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { mutation } from "../logic";
import { anyone } from "../policies";
import { Enquiry, enquiries } from "./schema";

export const create = mutation({
  description: "A guest asks about a property",
  inputSchema: z.object({ propertyId: z.uuid(), guestEmail: z.email(), message: z.string().min(1) }),
  authorize: anyone,
  expose: true,
  outputSchema: Enquiry,
  async execute(input, { db, scope }) {
    const [e] = await db.insert(enquiries).values({ ...input, accountId: scope.accountId }).returning();
    return e!;
  },
});

export const markWon = mutation({
  description: "An enquiry turned into a confirmed booking",
  inputSchema: z.object({ enquiryId: z.uuid() }),
  async execute({ enquiryId }, { db, scope }) {
    await db
      .update(enquiries)
      .set({ status: "won" })
      .where(and(eq(enquiries.id, enquiryId), eq(enquiries.accountId, scope.accountId)));
  },
});
