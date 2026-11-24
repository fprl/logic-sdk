import { init } from "logic-sdk";

export const { mutation, action } = init<{ scope: { user: string }; db: { rows: unknown[] } }>();
