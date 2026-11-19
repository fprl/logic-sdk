import * as links from "../links";
import { on } from "../logic";
import { record } from "./mutations";

export const countVisit = on(() => links.visited, async ({ slug }, { run }) => {
  await run(record, { slug });
});
