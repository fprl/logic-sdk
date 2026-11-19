import { init } from "logic-sdk";

export const { query, mutation, action, event, on } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
