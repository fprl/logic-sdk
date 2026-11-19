import { asc } from "drizzle-orm";
import { z } from "zod";
import { anyone, query } from "../logic";
import { Product, products } from "./schema";

export const list = query({
  description: "Everything for sale, with prices and stock",
  inputSchema: z.undefined(),
  authorize: anyone,
  expose: true,
  outputSchema: z.array(Product),
  execute: (_, { db }) => db.select().from(products).orderBy(asc(products.name)),
});
