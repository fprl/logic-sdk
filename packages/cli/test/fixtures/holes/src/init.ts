import { init } from "logic-sdk";

export const { query, mutation, action, event, listener } = init<{ scope: { user: string }; db: { rows: unknown[]; run(sql: string): void } }>();
