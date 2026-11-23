import { z } from "zod";
import { action } from "./init";
import * as mail from "./mail";

export const log = action({
  input: z.object({ to: z.string() }),
  handler: async ({ run }, { to }): Promise<unknown> => run(mail.send, { to }),
});
