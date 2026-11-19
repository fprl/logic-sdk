import { init } from "logic-sdk";

export const { query, mutation: defineMutation, action, event, on } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
