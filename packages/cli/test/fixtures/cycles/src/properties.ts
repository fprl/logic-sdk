// Reads both ways with bookings: not a cycle, since a query can't write.
import { z } from "zod";
import * as bookings from "./bookings";
import { query } from "./init";

export const get = query({
  input: z.object({ propertyId: z.string() }),
  handler: async (_, { propertyId }) => ({ propertyId, capacity: 4 }),
});

export const page = query({
  input: z.object({ propertyId: z.string() }),
  handler: async ({ run }, { propertyId }) => ({ current: await run(bookings.currentFor, { propertyId }) }),
});
