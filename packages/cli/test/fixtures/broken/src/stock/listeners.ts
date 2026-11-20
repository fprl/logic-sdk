import { listener } from "../init";
import * as orders from "../orders";

// ! nothing emits orders.shipped
export const restock = listener({ event: () => orders.shipped, description: "Reacts to orders.shipped", handler: async () => {} });
