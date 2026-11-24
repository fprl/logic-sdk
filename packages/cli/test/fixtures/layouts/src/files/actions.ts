import { z } from "zod";
import { action } from "../init";

/** Delete what's stored */
const purge = action({
  input: z.object({ key: z.string() }),
  handler: async () => {},
});

export { purge };
