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

/** The module part of an id: "bookings" for "bookings.confirm". */
export const moduleOf = (id: string) => id.slice(0, id.indexOf("."));

/** How an unnamed private function (one its module's index doesn't export) is named: `files.(private)`. */
export const PRIVATE = "(private)";

/** What a call its policy refused throws: "bookings.cancel.forbidden", and "files.forbidden" for an unnamed private function. */
export const forbiddenOf = (id: string) => `${id === `${moduleOf(id)}.${PRIVATE}` ? moduleOf(id) : id}.forbidden`;

/** `ctx.errors` for one function or listener (`id` like "bookings.confirm"). */
export const errorsFor = (id: string): Errors => {
  const module = moduleOf(id);
  return {
    reject: (code, details) => new DomainError("rejected", `${module}.${code}`, details),
    conflict: (code, details) => new DomainError("conflict", `${module}.${code}`, details),
    notFound: (code = "not_found", details) => new DomainError("not_found", `${module}.${code}`, details),
    deny: (code, details) => new DomainError("forbidden", code ? `${module}.${code}` : forbiddenOf(id), details),
  };
};

/** What a schema said, as JSON: `[{ message, path }]`. */
export const describeIssues = (issues: readonly StandardSchemaV1.Issue[]) =>
  issues.map((i) => ({ message: i.message, path: i.path?.map((p) => (typeof p === "object" ? p.key : p)) }));

/** A payload that stopped matching its event's schema (a deploy changed it while it waited): delivering again won't help. */
export class StalePayload extends Error {}

/**
 * A mutation's commit after a nested mutation failed and was caught: the transaction they share is doomed. Its
 * `cause` is that failure, and retries (a transaction's, a job's) treat it as the cause would be treated.
 */
export class CaughtNestedFailure extends Error {}

/**
 * Throw where there's no valid session, outside your functions (a route, a middleware): `toResponse` makes it a 401.
 * Inside a function, a policy answers instead (a scope with no actor, then `forbidden`).
 */
export const unauthenticated = (code = "unauthenticated", details?: unknown) => new DomainError("unauthenticated", code, details);

/**
 * An error and the ones it wraps (`cause`), six deep at most: a driver's error usually arrives wrapped by the ORM,
 * and a caught nested failure wraps that once more.
 */
export function* causes(error: unknown): Generator<object> {
  for (let e = error, i = 0; typeof e === "object" && e !== null && i < 6; e = "cause" in e ? e.cause : undefined, i++) yield e;
}
