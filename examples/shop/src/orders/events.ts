import { z } from "zod";
import { event } from "../logic";

export const placed = event({
  payload: z.object({ orderId: z.uuid(), customerId: z.string(), total: z.int() }),
});
