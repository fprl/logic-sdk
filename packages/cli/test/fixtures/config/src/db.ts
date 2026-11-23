import { drizzle } from "drizzle-orm/node-postgres";

export const connect = (url: string) => drizzle(url);
export type Db = ReturnType<typeof connect>;
