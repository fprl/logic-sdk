import { init } from "logic-sdk";

export const { query, mutation: defineMutation, action, event, listener } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
