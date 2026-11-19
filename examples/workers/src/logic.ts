import {
  init,
  type ActionCtx as Action,
  type ListenerCtx as Listener,
  type MutationCtx as Mutation,
  type QueryCtx as Query,
} from "logic-sdk";
import type { DrizzleReader, DrizzleTx } from "logic-sdk/drizzle";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export type Db = PostgresJsDatabase;
type Tx = DrizzleTx<Db>;

/** Who is calling: your own type, the library only passes it along. A union, so policies can narrow it. */
export type Scope = { user: null } | SignedIn;
type SignedIn = { user: string };

type Config = {
  scope: Scope;
  db: Tx;
  reader: DrizzleReader<Tx>;
  // Bindings go straight in: actions and listeners use them like any client
  services: { archive: R2Bucket };
};

// For helpers that take ctx. Queries and mutations never see services; actions and listeners do.
export type QueryCtx = Query<Config>;
export type MutationCtx = Mutation<Config>;
export type ActionCtx = Action<Config>;
export type ListenerCtx<Payload> = Listener<Config, Payload>;

export const { query, mutation, event, on, createRegistry } = init<Config>();

// Policies: who may call a function at all. Plain sync functions over the scope, used as `authorize: signedIn`.
export const anyone = () => true;
export const signedIn = (scope: Scope): scope is SignedIn => scope.user !== null;
