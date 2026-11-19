import { createRegistry } from "logic-sdk";
import * as orders from "./domains/orders";
import * as stock from "./domains/stock";

export const registry = createRegistry({ modules: { orders, stock } });
