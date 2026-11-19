import { init, type MutationCtx as Mutation, type QueryCtx as Query } from "logic-sdk";
import type { DrizzleReader, DrizzleTx } from "logic-sdk/drizzle";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type Db = PgAsyncDatabase<PgQueryResultHKT>;
type Tx = DrizzleTx<Db>;

/** Who is calling: your own type, the library only passes it along. A union, so policies can narrow it. */
export type User = { id: string; role: "customer" | "staff" };
export type Scope = { user: null } | SignedIn;
export type SignedIn = { user: User };

/** Settings every function reads as `ctx.config`. Filled from env at the entry (see shop.ts). */
export type Settings = {
  app: { url: string };
  orders: { maxItems: number };
};

export interface Mailer {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

type Config = {
  scope: Scope;
  db: Tx;
  reader: DrizzleReader<Tx>;
  services: { mailer: Mailer };
  config: Settings;
};

// For helpers that take ctx: `findOrder(ctx, id)`.
export type QueryCtx<S = Scope> = Query<Config, S>;
export type MutationCtx<S = Scope> = Mutation<Config, S>;

export const { query, mutation, event, on, createRegistry } = init<Config>();

// Policies: who may call a function at all. Plain sync functions over the scope, used as `authorize: signedIn`.
export const anyone = () => true;
export const signedIn = (scope: Scope): scope is SignedIn => scope.user !== null;
export const staff = (scope: Scope): scope is SignedIn => scope.user?.role === "staff";
