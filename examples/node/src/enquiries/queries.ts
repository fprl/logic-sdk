import { eq } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { Enquiry, enquiries } from "./schema";

export const list = query({
  description: "Enquiries for the account, newest first",
  inputSchema: z.object({}).optional(),
  expose: "agent",
  outputSchema: z.array(Enquiry),
  execute: (_, { db, scope }) => db.select().from(enquiries).where(eq(enquiries.accountId, scope.accountId)),
});
