import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Errors } from "./types.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * Errors
 * ──────────────────────────────────────────────────────────────────────────── */

export type ErrorKind = "invalid" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "rejected";

/**
 * An expected failure: a `kind` (a small fixed set), a namespaced `code` and optional `details`. No HTTP here;
 * adapters map kinds to statuses. Anything else thrown (including invalid output or event payloads, which are
 * bugs) is unexpected: adapters answer 500 and report it.
 */
export class DomainError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly details: unknown;
  constructor(kind: ErrorKind, code: string, details?: unknown) {
    // the details are in the message too: logs and AI tool errors (which show only the message) stay useful
    super(details === undefined ? code : `${code} ${JSON.stringify(details)}`);
    this.name = "DomainError";
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}
/** `isDomainError(e)`, or with a code: `isDomainError(e, "availability.dates_unavailable")`. */
export const isDomainError = (e: unknown, code?: string): e is DomainError =>
  e instanceof DomainError && (code === undefined || e.code === code);

/** `ctx.errors` for one function or listener (`id` like "bookings.confirm"). */
export const errorsFor = (id: string): Errors => {
  const module = id.slice(0, id.indexOf("."));
  return {
    reject: (code, details) => new DomainError("rejected", `${module}.${code}`, details),
    conflict: (code, details) => new DomainError("conflict", `${module}.${code}`, details),
    notFound: (code = "not_found", details) => new DomainError("not_found", `${module}.${code}`, details),
    deny: (code, details) => new DomainError("forbidden", code ? `${module}.${code}` : `${id}.forbidden`, details),
  };
};

/** What a schema said, as JSON: `[{ message, path }]`. */
export const describeIssues = (issues: readonly StandardSchemaV1.Issue[]) =>
  issues.map((i) => ({ message: i.message, path: i.path?.map((p) => (typeof p === "object" ? p.key : p)) }));

/** A payload that stopped matching its event's schema (a deploy changed it while it waited): delivering again won't help. */
export class StalePayload extends Error {}

/**
 * Throw where there's no valid session, outside your functions (a route, a middleware): `toResponse` makes it a 401.
 * Inside a function, a policy answers instead (a scope with no actor, then `forbidden`).
 */
export const unauthenticated = (code = "unauthenticated", details?: unknown) => new DomainError("unauthenticated", code, details);
