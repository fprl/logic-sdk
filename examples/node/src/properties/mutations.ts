import { z } from "zod";
import { mutation } from "../logic";
import { Property, properties } from "./schema";

export const create = mutation({
  description: "Add a property to the account",
  inputSchema: z.object({
    name: z.string().min(1),
    nightlyRate: z.int().positive(),
    cleaningFee: z.int().min(0),
    minNights: z.int().min(1).default(1),
  }),
  expose: "owner",
  outputSchema: Property,
  async execute(input, { db, scope }) {
    const [p] = await db.insert(properties).values({ ...input, accountId: scope.accountId }).returning();
    return p!;
  },
});
