import { toORPCProcedure } from "logic-sdk/orpc";
import * as availability from "./availability";
import * as bookings from "./bookings";
import * as enquiries from "./enquiries";
import * as pricing from "./pricing";
import * as properties from "./properties";
import * as tasks from "./tasks";

/** The API: every function a client may call, in one place. The rest are internal: other modules run them. */
export const router = {
  availability: { block: toORPCProcedure(availability.block), check: toORPCProcedure(availability.check) },
  bookings: {
    request: toORPCProcedure(bookings.request),
    confirm: toORPCProcedure(bookings.confirm),
    cancel: toORPCProcedure(bookings.cancel),
    checkout: toORPCProcedure(bookings.checkout),
    get: toORPCProcedure(bookings.get),
  },
  enquiries: { create: toORPCProcedure(enquiries.create), list: toORPCProcedure(enquiries.list) },
  pricing: { priceStay: toORPCProcedure(pricing.priceStay) },
  properties: { create: toORPCProcedure(properties.create), get: toORPCProcedure(properties.get) },
  tasks: { list: toORPCProcedure(tasks.list) },
};
