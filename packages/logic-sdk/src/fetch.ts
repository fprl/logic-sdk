import { isDomainError, type ErrorKind } from "./index.ts";

/** Error kind → HTTP status. The only place statuses exist: core errors know nothing about HTTP. */
export const statusOf: Record<ErrorKind, number> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rejected: 422,
};

/**
 * A domain error as a JSON response, `{ error: { kind, code, details } }` with its status, for your own routes
 * (Hono, Next route handlers, anything web-standard). Anything else is thrown again, so your framework makes the 500
 * and logs it, and its message never reaches the client.
 *
 * ```ts
 * app.post("/orders", async (c) => {
 *   try {
 *     return c.json(await c.var.caller.run(orders.place, await c.req.json()), 201);
 *   } catch (e) {
 *     return toResponse(e);
 *   }
 * });
 * ```
 */
export function toResponse(error: unknown): Response {
  if (!isDomainError(error)) throw error;
  return Response.json({ error: { kind: error.kind, code: error.code, details: error.details } }, { status: statusOf[error.kind] });
}
