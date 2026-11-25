import { asSystem, cron } from "../logic";
import { toShip } from "./queries";

/**
 * Weekday mornings, Madrid time, email staff how many orders wait to ship. A cron has no caller: it runs as the system,
 * by name, and what it runs checks that scope (`toShip` grants it with `staffOrSystem`).
 */
export const sendDigest = cron({
  schedule: "0 8 * * 1-5",
  timezone: "Europe/Madrid",
  scope: asSystem("orders.sendDigest"),
  async handler(ctx) {
    const waiting = await ctx.run(toShip);
    if (waiting > 0) await ctx.services.mailer.send({ to: "staff", subject: `${waiting} orders to ship`, text: `${ctx.config.app.url}/orders` });
  },
});
