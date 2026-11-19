import { z } from "zod";
import { query } from "../logic";
import { anyone } from "../policies";
import * as properties from "../properties";

const nightsBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export const priceStay = query({
  description: "Price a stay: nights × nightly rate + cleaning fee. Enforces minimum nights.",
  inputSchema: z.object({ propertyId: z.uuid(), from: z.iso.date(), to: z.iso.date() }),
  authorize: anyone,
  expose: true,
  outputSchema: z.object({ nights: z.number(), nightly: z.number(), cleaning: z.number(), total: z.number() }),
  async execute({ propertyId, from, to }, { run, errors }) {
    const p = await run(properties.get, { propertyId });
    const nights = nightsBetween(from, to);
    if (nights < p.minNights) throw errors.reject("min_nights", { minNights: p.minNights, nights });
    return { nights, nightly: p.nightlyRate, cleaning: p.cleaningFee, total: nights * p.nightlyRate + p.cleaningFee };
  },
});
