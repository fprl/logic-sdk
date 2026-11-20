import { init } from "logic-sdk";

export const { query, mutation, event, listener } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
