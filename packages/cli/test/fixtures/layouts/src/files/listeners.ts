// Forgotten: files.ts doesn't export * from here, and nothing imports this file
import { z } from "zod";
import { event, on } from "../init";

const removed = event({ payload: z.object({ key: z.string() }) });

/** Exported from its file, still never registered */
export const onRemoved = on({ event: () => removed, handler: async () => {} });
const onRemovedToo = on({ event: () => removed, handler: async () => {} });
void onRemovedToo;
