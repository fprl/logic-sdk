import { env } from "../env";
export const linkFor = (id: string) => `${env.APP_URL}/orders/${id}`;
