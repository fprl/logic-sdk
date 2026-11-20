import { eq } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { agent } from "../policies";
import { Enquiry, enquiries } from "./schema";

export const list = query({
  description: "Enquiries for the account, newest first",
  input: z.object({}).optional(),
  authorize: agent,
  expose: true,
  output: z.array(Enquiry),
  handler: (ctx) => ctx.db.select().from(enquiries).where(eq(enquiries.accountId, ctx.scope.accountId)),
});
