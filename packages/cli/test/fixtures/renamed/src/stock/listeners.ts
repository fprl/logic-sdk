import { on } from "../init";
import * as orders from "../orders";

// ! nothing emits orders.shipped
export const restock = on(() => orders.shipped, async () => {});
