import { init } from "logic-sdk";

export const { query, mutation, action } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
