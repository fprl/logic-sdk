import { z } from "zod";
import { query } from "../logic";
import { anyone } from "../policies";
import { findProperty } from "./data";
import { Property } from "./schema";

/** Get a property by id */
export const get = query({
  input: z.object({ propertyId: z.uuid() }),
  authorize: anyone,
  output: Property,
  handler: (ctx, input) => findProperty(ctx, input.propertyId),
});
