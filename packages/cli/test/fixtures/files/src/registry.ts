import { createRegistry } from "logic-sdk";
import * as orders from "./orders";
import * as stock from "./stock";

export const registry = createRegistry({ modules: { orders, stock } });
