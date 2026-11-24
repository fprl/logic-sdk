// A test's own definitions are never registered on purpose: not reported
import { mutation } from "../init";

export const scratch = mutation({ handler: async () => 1 });
