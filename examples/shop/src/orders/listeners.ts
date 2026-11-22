import { listener } from "../logic";
import { placed } from "./events";

/** Email a receipt once the order is committed, never for one that rolled back */
export const sendReceipt = listener({
  event: () => placed,
  attempts: 3, // mail providers have bad minutes
  async handler(ctx, payload) {
    const { orderId, customerId, total } = payload;
    await ctx.services.mailer.send({
      to: customerId,
      subject: `Thanks for your order (€${(total / 100).toFixed(2)})`,
      text: `Order ${orderId} is placed. See your orders at ${ctx.config.app.url}`,
      idempotencyKey: `receipt:${ctx.event.id}`, // a job can run twice
    });
  },
});
