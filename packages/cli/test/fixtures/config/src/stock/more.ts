import { z } from "zod";
import process2, { env as nodeEnv } from "node:process";
import { mutation } from "../logic";

export const variants = mutation({
  description: "Every way to reach env that check must catch",
  inputSchema: z.object({}),
  async execute() {
    const a = process["env"].A; // flagged
    const b = globalThis.process.env.B; // flagged
    const { env } = process; // flagged
    const c = (globalThis as any).Bun?.env; // not flagged: too dynamic to promise
    return { a, b, c, d: env.D, e: nodeEnv.E, f: process2.env.F };
  },
});
