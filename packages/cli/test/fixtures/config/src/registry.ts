import { createRegistry } from "logic-sdk";
import * as orders from "./orders";

export const registry = createRegistry({ modules: { orders } });
