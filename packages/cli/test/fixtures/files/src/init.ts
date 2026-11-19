import { init } from "logic-sdk";

export const { query, mutation, event, on } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
