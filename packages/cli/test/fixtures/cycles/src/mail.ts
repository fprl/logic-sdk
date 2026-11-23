// Actions in a circle with crm: no transaction, still a loop.
import { z } from "zod";
import * as crm from "./crm";
import { action } from "./init";

export const send = action({
  input: z.object({ to: z.string() }),
  handler: async ({ run }, { to }): Promise<unknown> => run(crm.log, { to }),
});
