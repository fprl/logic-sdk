import { on } from "../logic";
import { placed } from "./events";

/** Email a receipt once the order is committed, never for one that rolled back. */
export const sendReceipt = on(() => placed, async ({ orderId, customerId, total }, { services, config }) => {
  await services.mailer.send({
    to: customerId,
    subject: `Thanks for your order (€${(total / 100).toFixed(2)})`,
    text: `Order ${orderId} is placed. See your orders at ${config.app.url}`,
  });
});
