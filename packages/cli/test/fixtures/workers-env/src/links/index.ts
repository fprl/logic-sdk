import { env } from "cloudflare:workers"; // a module reading the Worker's env: can't even load outside workerd

export const base = env.BASE_URL;
