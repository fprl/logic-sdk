import { init, type MutationCtx } from "logic-sdk";

export type Scope = { actor: string | null };
type Config = { scope: Scope; db: { rows: unknown[] }; config: { app: { url: string }; orders: { maxItems: number; currency: string; tags: string[] } } };
export type Ctx = MutationCtx<Config>;

export const { query, mutation, action, event, listener, createRegistry } = init<Config>();
