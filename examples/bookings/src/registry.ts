import { drizzleAdapter } from "logic-sdk/drizzle";
import { createRegistry, type Db } from "./logic";
import type { Services } from "./services";
import * as availability from "./availability";
import * as bookings from "./bookings";
import * as enquiries from "./enquiries";
import * as pricing from "./pricing";
import * as properties from "./properties";
import * as tasks from "./tasks";

/** The only file that imports every module. `waitUntil` for serverless hosts (the shop example shows Next.js and Workers). */
export const makeRegistry = (db: Db, services: Services, options: { waitUntil?: (p: Promise<unknown>) => void } = {}) =>
  createRegistry({
    modules: { properties, availability, pricing, enquiries, bookings, tasks },
    database: drizzleAdapter(db),
    services,
    ...options,
  });

export type AppRegistry = ReturnType<typeof makeRegistry>;
