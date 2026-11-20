import { init, type MutationCtx as Mutation, type QueryCtx as Query } from "logic-sdk";
import type { DrizzleReader, DrizzleTx } from "logic-sdk/drizzle";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Scope } from "./scope";
import type { Services } from "./services";

export type Db = PgAsyncDatabase<PgQueryResultHKT>;
export type Tx = DrizzleTx<Db>;
type Config = { scope: Scope; db: Tx; reader: DrizzleReader<Tx>; services: Services };

/** What helpers take: `findBooking(ctx, id)`. A mutation's ctx works where a QueryCtx is expected. */
export type QueryCtx = Query<Config>;
export type MutationCtx = Mutation<Config>;

export const { query, mutation, action, event, on, createRegistry } = init<Config>();
