import { ORPCError, os, type DecoratedProcedure } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isDomainError, type ErrorKind } from "../core/errors.ts";
import type { Caller, Fn, Kind, PublishableFn, ScopeOfFn } from "../core/types.ts";

/** oRPC context a procedure expects: bind who is calling per request, in your handler or middleware. */
export type ORPCContext<S extends object> = { caller: Caller<S> };

/** `toORPCProcedure(fn)`: an oRPC procedure, so `.use`, `.meta` and `.errors` work as on your own. */
export type ProcedureOf<F> =
  F extends Fn<Kind, infer I, infer O>
    ? DecoratedProcedure<ORPCContext<ScopeOfFn<F>>, object, StandardSchemaV1<I, I>, StandardSchemaV1<O, O>, {}>
    : never;

/** Domain error kind → oRPC error code (and so HTTP status through oRPC's handlers). */
export const orpcCodeOf: Record<ErrorKind, string> = {
  invalid: "BAD_REQUEST",
  unauthenticated: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  rejected: "UNPROCESSABLE_CONTENT",
};

/**
 * One function as an oRPC procedure, for your own router: the router is your API surface, one file, next to your
 * own procedures and middleware. Validation runs once, in the registry. It needs `authorize`: callers are untrusted.
 *
 * ```ts
 * export const router = { bookings: { confirm: toORPCProcedure(bookings.confirm) } };
 * new RPCHandler(router).handle(request, { prefix: "/rpc", context: { caller: registry.as(await scopeFrom(request)) } });
 * ```
 */
export function toORPCProcedure<F extends PublishableFn>(fn: F): ProcedureOf<F> {
  if (!fn.authorize) throw new Error("[logic-sdk] toORPCProcedure publishes a function, so it needs authorize: say who may call it (everyone is `authorize: anyone`).");
  const base = os.$context<ORPCContext<object>>().$config({ disableInputValidation: true, disableOutputValidation: true });
  const withInput = fn.input ? base.input(fn.input) : base;
  const b = fn.output ? withInput.output(fn.output) : withInput;
  return b.handler(async ({ input, context, signal }) => {
    try {
      return await context.caller.run(fn, input, { signal });
    } catch (e) {
      if (isDomainError(e)) throw new ORPCError(orpcCodeOf[e.kind], { message: e.code, data: { kind: e.kind, code: e.code, details: e.details } });
      throw e;
    }
  }) as ProcedureOf<F>; // SAFETY: the same procedure, typed from the function: its input, output and init's scope
}
