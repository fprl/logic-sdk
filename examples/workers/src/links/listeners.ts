import { on } from "../logic";
import { created } from "./events";

/** Keep a copy of every new link in R2, after the response is sent. */
export const archive = on(() => created, async (link, { services }) => {
  await services.archive.put(`links/${link.slug}.json`, JSON.stringify(link), {
    httpMetadata: { contentType: "application/json" },
  });
});
