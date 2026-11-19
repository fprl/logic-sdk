import { tool, type FlexibleSchema, type Tool } from "ai";
import { isDomainError, type Caller, type Fn, type FnIn, type FnOut, type Registry, type RegisteredFn } from "./index.ts";

type ExposedOf<T> = { [N in keyof T as T[N] extends Fn<any, any, any, true> ? N : never]: T[N] };
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

/** `{ bookings_confirm, pricing_priceStay, … }`: one AI SDK tool per exposed function, typed. */
export type AIToolsOf<Mods> = UnionToIntersection<
  {
    [M in keyof Mods & string]: {
      [N in keyof ExposedOf<Mods[M]> & string as `${M}_${N}`]: Tool<
        FnIn<Mods[M][N & keyof Mods[M]]>,
        FnOut<Mods[M][N & keyof Mods[M]]>
      >;
    };
  }[keyof Mods & string]
>;

export interface AIToolsOptions {
  /** Keep only some exposed functions, e.g. `(f) => f.fn.meta?.agent !== false`. */
  filter?: (fn: RegisteredFn) => boolean;
  /** Unexpected (non-domain) errors. The model only sees "internal_error". Default: console.error. */
  onError?: (error: unknown) => void;
}

/**
 * Exposed functions as AI SDK tools, run as `caller`: an agent goes through the same policies,
 * validation, transactions and events as your HTTP API. Tool names are `<module>_<function>`.
 *
 * ```ts
 * const caller = registry.as(await scopeFrom(request));
 * await generateText({ model, tools: toAITools(registry, caller), prompt });
 * ```
 *
 * Domain errors reach the model (it sees the code and can react). Anything unexpected is reported
 * to `onError` and the model gets "internal_error", so internals never land in its context.
 */
export function toAITools<S extends object, Mods extends Record<string, object>>(
  registry: Registry<S, Mods>,
  caller: Caller<S>,
  options: AIToolsOptions = {},
): AIToolsOf<Mods> {
  const onError = options.onError ?? ((e) => console.error("[logic-sdk] tool failed unexpectedly", e));
  const tools: Record<string, Tool> = {};

  for (const f of registry.functions) {
    if (!f.exposed || (options.filter && !options.filter(f))) continue;
    tools[`${f.module}_${f.name}`] = tool({
      description: f.fn.description,
      inputSchema: f.fn.inputSchema as FlexibleSchema,
      outputSchema: f.fn.outputSchema as FlexibleSchema,
      async execute(input) {
        try {
          return await caller.run(f.fn, input);
        } catch (e) {
          if (isDomainError(e)) throw e;
          onError(e);
          throw new Error("internal_error");
        }
      },
    });
  }
  return tools as AIToolsOf<Mods>;
}
