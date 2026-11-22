import { init, type MutationCtx as Mutation, type QueryCtx as Query } from "logic-sdk";
import type { DrizzleDb } from "logic-sdk/drizzle";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Scope } from "./scope";
import type { Services } from "./services";

export type Db = PgAsyncDatabase<PgQueryResultHKT>;
type Config = { scope: Scope; db: DrizzleDb<Db>; services: Services };

/** What helpers take: `findBooking(ctx, id)`. A mutation's ctx works where a QueryCtx is expected. */
export type QueryCtx = Query<Config>;
export type MutationCtx = Mutation<Config>;

export const { query, mutation, action, event, listener, createRegistry } = init<Config>();
