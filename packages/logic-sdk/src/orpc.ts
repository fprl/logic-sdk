import { ORPCError, os, type Procedure } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isDomainError, type Caller, type ErrorKind, type Fn, type Registry } from "./index.ts";

/** oRPC context the router expects: bind who is calling per request, in your handler or middleware. */
export type ORPCContext<S extends object> = { caller: Caller<S> };

type ProcedureOf<S extends object, F> =
  F extends Fn<any, infer I, infer O, true>
    ? Procedure<ORPCContext<S>, ORPCContext<S>, StandardSchemaV1<I, I>, StandardSchemaV1<O, O>, {}>
    : never;

/** `{ bookings: { confirm, cancel, … } }`: only functions with `expose: true`. */
export type ORPCRouterOf<S extends object, Mods> = {
  [M in keyof Mods as {} extends ExposedOf<Mods[M]> ? never : M]: {
    [N in keyof ExposedOf<Mods[M]>]: ProcedureOf<S, Mods[M][N & keyof Mods[M]]>;
  };
};
type ExposedOf<T> = { [N in keyof T as T[N] extends Fn<any, any, any, true> ? N : never]: T[N] };

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
 * Turn the registry into an oRPC router. Your modules stay the core; oRPC is the edge that gives you
 * a typed client, OpenAPI and MCP. Validation runs once, in the registry.
 *
 * ```ts
 * const router = toORPCRouter(registry);
 * const handler = new RPCHandler(router);
 * handler.handle(request, { prefix: "/rpc", context: { caller: registry.as(await scopeFrom(request)) } });
 * ```
 */
export function toORPCRouter<S extends object, Mods extends Record<string, object>>(
  registry: Registry<S, Mods>,
): ORPCRouterOf<S, Mods> {
  const base = os.$context<ORPCContext<S>>().$config({ disableInputValidation: true, disableOutputValidation: true });
  const router: Record<string, Record<string, unknown>> = {};

  for (const f of registry.functions) {
    if (!f.exposed) continue;
    let b = base.input(f.fn.inputSchema as StandardSchemaV1);
    if (f.fn.outputSchema) b = b.output(f.fn.outputSchema as StandardSchemaV1) as any;
    (router[f.module] ??= {})[f.name] = b.handler(async ({ input, context, signal }) => {
      try {
        return await context.caller.run(f.fn, input, { signal });
      } catch (e) {
        if (isDomainError(e))
          throw new ORPCError(orpcCodeOf[e.kind], {
            message: e.code,
            data: { kind: e.kind, code: e.code, details: e.details },
          });
        throw e;
      }
    });
  }
  return router as ORPCRouterOf<S, Mods>;
}
