// Never executed by the CLI: only parsed. A real app would pass a database here.
import { createRegistry } from "logic-sdk";
import * as orders from "./orders";
import * as stock from "./stock";

export const registry = createRegistry({ modules: { orders, stock } });
