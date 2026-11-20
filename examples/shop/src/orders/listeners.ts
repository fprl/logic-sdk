import { listener } from "../logic";
import { placed } from "./events";

export const sendReceipt = listener({
  event: () => placed,
  description: "Email a receipt once the order is committed, never for one that rolled back",
  async handler(ctx, payload) {
    const { orderId, customerId, total } = payload;
    await ctx.services.mailer.send({
      to: customerId,
      subject: `Thanks for your order (€${(total / 100).toFixed(2)})`,
      text: `Order ${orderId} is placed. See your orders at ${ctx.config.app.url}`,
    });
  },
});
