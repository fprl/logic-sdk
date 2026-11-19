import type { Ctx } from "../logic";

/** A helper: show orders.place lists app.url through it. */
export const orderLink = (ctx: Ctx, id: string) => `${ctx.config.app.url}/orders/${id}`;
