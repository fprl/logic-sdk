import { drizzleAdapter } from "logic-sdk/drizzle";
import { createRegistry, type Db } from "./logic";
import type { Services } from "./services";
import * as availability from "./availability";
import * as bookings from "./bookings";
import * as enquiries from "./enquiries";
import * as pricing from "./pricing";
import * as properties from "./properties";
import * as tasks from "./tasks";

/** The only file that imports every module. */
export const makeRegistry = (db: Db, services: Services) =>
  createRegistry({
    modules: { properties, availability, pricing, enquiries, bookings, tasks },
    database: drizzleAdapter(db),
    services,
  });

export type AppRegistry = ReturnType<typeof makeRegistry>;
