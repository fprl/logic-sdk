import { z } from "zod";
import * as billing from "./billing";
import { mutation, query } from "./init";
import * as properties from "./properties";

export const currentFor = query({
  input: z.object({ propertyId: z.string() }),
  handler: async () => null,
});

export const create = mutation({
  input: z.object({ propertyId: z.string() }),
  handler: async ({ run }, { propertyId }) => run(properties.get, { propertyId }),
});

export const confirm = mutation({
  input: z.object({ bookingId: z.string() }),
  handler: async ({ run }, { bookingId }) => run(billing.charge, { bookingId }),
});

export const markPaid = mutation({
  input: z.object({ bookingId: z.string() }),
  handler: async () => null,
});
