import { createRegistry } from "logic-sdk";
import * as bookings from "@acme/logic/bookings";

export const registry = createRegistry({ modules: { bookings } });
