// Shared by files and stock, owned by neither: each runs `log` as its own private function
import { z } from "zod";
import { event, mutation, on } from "../init";

/** Write an audit line */
export const log = mutation({ handler: async () => 1 });

const audited = event({ payload: z.object({ line: z.string() }) });
/** Forgotten, in a shared file: listed once */
export const onAudited = on({ event: () => audited, handler: async () => {} });
