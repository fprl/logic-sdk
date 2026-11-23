import { createRegistry } from "logic-sdk";
import * as billing from "./billing";
import * as bookings from "./bookings";
import * as crm from "./crm";
import * as mail from "./mail";
import * as properties from "./properties";

export const registry = createRegistry({ modules: { billing, bookings, crm, mail, properties } });
