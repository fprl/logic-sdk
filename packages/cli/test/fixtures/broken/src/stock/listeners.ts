import { listener } from "../init";
import * as orders from "../orders";

// ! nothing emits orders.shipped
/** Reacts to orders.shipped */
export const restock = listener({ event: () => orders.shipped, handler: async () => {} });
