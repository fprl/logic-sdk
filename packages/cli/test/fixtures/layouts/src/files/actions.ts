import { z } from "zod";
import { action, mutation } from "../init";
import * as data from "./data";

/** Delete what's stored */
const purge = action({
  input: z.object({ key: z.string() }),
  handler: async () => {},
});

/** Store a file: the only way to record one */
export const upload = action({
  handler: async (ctx) => {
    await ctx.run(data.record); // through a namespace import
    await ctx.run(tidy);
  },
});

/** Unexported in its file, with an id for traces */
const tidy = mutation({ id: "tidy", handler: async () => 1 });

export { purge };
