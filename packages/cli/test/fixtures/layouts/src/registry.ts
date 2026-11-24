import { createRegistry } from "logic-sdk";
import * as files from "./files";
import * as stock from "./stock";

export const registry = createRegistry({ modules: { files, stock } });
