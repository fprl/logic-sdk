import { z } from "zod";
import { query } from "../logic";
import { findProperty } from "./data";
import { Property } from "./schema";

export const get = query({
  description: "Get a property by id",
  inputSchema: z.object({ propertyId: z.uuid() }),
  expose: "public",
  outputSchema: Property,
  execute: ({ propertyId }, ctx) => findProperty(ctx, propertyId),
});
