import { z } from "zod";
import type { Row } from "@/stock/data"; // ✗ tsconfig paths alias into stock's files
import type { Slot } from "#stock/data"; // ✗ package.json imports into stock's files
import { mutation } from "../init";
import * as stock from "../stock";
import { canHold, canShip } from "./rules";

export { reserved } from "../stock/data"; // ✗ re-export of stock's files
export const loadStock = () => import("../stock/data"); // ✗ dynamic import of stock's files

export const place = mutation({
  description: "Place an order",
  input: z.object({ sku: z.string() }),
  async handler(ctx, { sku }) {
    const byName: Record<string, typeof stock.reserve> = { reserve: stock.reserve };
    if (!(await canShip(sku))) throw ctx.errors.deny(); // ✗ async-can (awaited)
    canHold(sku); // ✗ unused-can
    ctx.db.run("insert"); // not an edge
    const row: Row | Slot = { sku };
    return ctx.run(byName["reserve"]!, row); // ! dynamic-run
  },
});
