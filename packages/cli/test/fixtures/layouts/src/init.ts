import { init } from "logic-sdk";

export const { mutation, action, event, listener: on } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
