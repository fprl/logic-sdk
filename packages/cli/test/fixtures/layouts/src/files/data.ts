// Private to files: files.ts doesn't re-export this file
import { z } from "zod";
import { event, mutation, on } from "../init";

/** Record what was stored */
export const record = mutation({ handler: async () => 1 });

const stored = event({ payload: z.object({ key: z.string() }) });

/** Forgotten: no index exports it, so it never runs */
export const onStored = on({ event: () => stored, handler: async () => {} });
