import { DomainError, isDomainError, type ErrorKind, type Registry } from "./index.ts";

/**
 * Throw from `resolveScope` when this mount is session-only and there's no valid session: the client gets 401.
 * For mounts that also serve public functions, return a scope with no actor instead, and let policies answer 403.
 */
export const unauthenticated = (code = "unauthenticated", details?: unknown) =>
  new DomainError("unauthenticated", code, details);

/** Error kind → HTTP status. The only place statuses exist: core errors know nothing about HTTP. */
export const statusOf: Record<ErrorKind, number> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rejected: 422,
};

export interface FetchOptions<S extends object> {
  /** Build the scope for this request (session → actor, account, locale...). */
  resolveScope: (request: Request, ...rest: any[]) => S | Promise<S>;
  /** Mount point. Default "/". Functions live at `${basePath}${id}`, e.g. `/api/bookings.confirm`. */
  basePath?: string;
  /** Unexpected (non-domain) errors. Default: console.error. */
  onError?: (error: unknown) => void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A web-standard handler (Workers, Bun, Node via Hono or srvx, SvelteKit, Next route handlers...).
 * Publishes only functions with `expose: true`. POST `{base}{id}` with a JSON body (`content-type: application/json` required);
 * queries also accept GET `?input=<json>`.
 */
export function toFetchHandler<S extends object>(registry: Registry<S>, options: FetchOptions<S>) {
  const base = (options.basePath ?? "/").replace(/\/?$/, "/");
  const exposed = new Map(registry.definitions.functions.filter((f) => f.exposed).map((f) => [f.id, f]));
  const onError = options.onError ?? ((e) => console.error("[logic-sdk] unexpected error", e));

  return async (request: Request, ...rest: any[]): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith(base)) return json({ error: { kind: "not_found", code: "route_not_found" } }, 404);
    const id = path.slice(base.length);

    const entry = exposed.get(id);
    if (!entry) return json({ error: { kind: "not_found", code: "function_not_found" } }, 404);

    let input: unknown;
    try {
      if (request.method === "POST") {
        // JSON only: blocks cross-site "simple" form posts (CSRF) because they can't send this content type without a preflight
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
          return json({ error: { kind: "invalid", code: "unsupported_media_type" } }, 415);
        const text = await request.text();
        input = text ? JSON.parse(text) : undefined;
      } else if (request.method === "GET" && entry.kind === "query") {
        const raw = url.searchParams.get("input");
        input = raw ? JSON.parse(raw) : undefined;
      } else {
        const res = json({ error: { kind: "invalid", code: "method_not_allowed" } }, 405);
        res.headers.set("allow", entry.kind === "query" ? "GET, POST" : "POST");
        return res;
      }
    } catch {
      return json({ error: { kind: "invalid", code: "malformed_json" } }, 400);
    }

    try {
      const scope = await options.resolveScope(request, ...rest);
      return json({ data: await registry.as(scope).run(entry.fn, input, { signal: request.signal }) });
    } catch (e) {
      if (isDomainError(e)) return json({ error: { kind: e.kind, code: e.code, details: e.details } }, statusOf[e.kind]);
      onError(e);
      return json({ error: { kind: "internal", code: "internal_error" } }, 500);
    }
  };
}
