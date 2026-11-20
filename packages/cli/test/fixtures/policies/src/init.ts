import { init, type MutationCtx } from "logic-sdk";

export type Actor = { id: string };
export type Scope = { actor: Actor | null; accountId: string };
export type MemberScope = Scope & { actor: Actor };
export type Order = { id: string; ownerId: string; status: string };
type Config = { scope: Scope; db: { rows: Order[]; run(sql: string): void } };
export type Ctx = MutationCtx<Config>;

/** A policy: who may call a function at all. */
export const member = (s: Scope): s is MemberScope => s.actor !== null;

export const { query, mutation, action, event, listener } = init<Config>();
