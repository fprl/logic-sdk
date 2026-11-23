import { z } from "zod";
import { query } from "../logic";
import { anyone } from "../policies";
import * as properties from "../properties";

const nightsBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

/** Price a stay: nights × nightly rate + cleaning fee. Enforces minimum nights. */
export const priceStay = query({
  input: z.object({ propertyId: z.uuid(), from: z.iso.date(), to: z.iso.date() }),
  authorize: anyone,
  output: z.object({ nights: z.number(), nightly: z.number(), cleaning: z.number(), total: z.number() }),
  async handler(ctx, input) {
    const { propertyId, from, to } = input;
    const p = await ctx.run(properties.get, { propertyId });
    const nights = nightsBetween(from, to);
    if (nights < p.minNights) throw ctx.errors.reject("min_nights", { minNights: p.minNights, nights });
    return { nights, nightly: p.nightlyRate, cleaning: p.cleaningFee, total: nights * p.nightlyRate + p.cleaningFee };
  },
});
