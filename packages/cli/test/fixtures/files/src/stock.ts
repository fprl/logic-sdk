import { z } from "zod";
import { mutation as defineMutation } from "./init";

// A single-file module: fine for small modules. Definers can have any name.
/** Reserve stock */
export const reserve = defineMutation({
  id: "hold",
  input: z.object({ sku: z.string() }),
  handler: async (_, { sku }) => ({ sku }),
});
