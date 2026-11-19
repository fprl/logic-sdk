import { z } from "zod";
import { mutation } from "../logic";
import type { Reservation } from "../lib/reservation"; // type-only: never flagged

export const reserve = mutation({
  description: "Reserve stock",
  inputSchema: z.object({ qty: z.number() }),
  async execute({ qty }): Promise<{ ok: boolean; debug: unknown; reservation?: Reservation }> {
    const max = Number(process.env.MAX_RESERVE ?? 10); // flagged
    const debug = import.meta.env?.DEBUG; // flagged
    return { ok: qty <= max, debug };
  },
});
