import { asc } from "drizzle-orm";
import { z } from "zod";
import { query } from "../logic";
import { anyone } from "../policies";
import { Product, products } from "./schema";

/** Everything for sale, with prices and stock */
export const list = query({
  authorize: anyone,
  expose: true,
  output: z.array(Product),
  handler: (ctx) => ctx.db.select().from(products).orderBy(asc(products.name)),
});
