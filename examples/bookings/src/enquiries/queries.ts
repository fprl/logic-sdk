import { eq } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { agent } from "../policies";
import { Enquiry, enquiries } from "./schema";

/** Enquiries for the account, newest first */
export const list = query({
  input: z.object({}).optional(),
  authorize: agent,
  output: z.array(Enquiry),
  handler: (ctx) => ctx.db.select().from(enquiries).where(eq(enquiries.accountId, ctx.scope.accountId)),
});
