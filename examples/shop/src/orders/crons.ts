import { action, cron } from "../logic";
import { staff } from "../policies";
import { toShip } from "./queries";

/** Email staff how many orders wait to ship */
export const sendDigest = action({
  authorize: staff,
  async handler(ctx) {
    const waiting = await ctx.run(toShip);
    if (waiting > 0) await ctx.services.mailer.send({ to: "staff", subject: `${waiting} orders to ship`, text: `${ctx.config.app.url}/orders` });
  },
});

/** Weekday mornings, Madrid time. A cron has no caller, so it says who it runs as. */
export const morningDigest = cron({
  schedule: "0 8 * * 1-5",
  timezone: "Europe/Madrid",
  run: sendDigest,
  scope: { user: { id: "system", role: "staff" } },
});
