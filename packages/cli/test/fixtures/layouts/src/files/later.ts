import { purge } from "./actions";

// A helper in a file the entry never exports
export const purgeLater = (ctx: { schedule: (...args: any[]) => void }, key: string) => ctx.schedule(purge, { key }, { delay: 0 });
