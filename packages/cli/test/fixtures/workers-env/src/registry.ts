import { createRegistry } from "logic-sdk";
import * as links from "./links";

export const registry = createRegistry({ modules: { links } });
