import { jsonSchema, tool, type Tool } from "ai";
import { isDomainError, type Caller, type ExposedFn, type ExposedOf, type Fn, type FnIn, type FnOut, type ForFunctions, type Registry, type RegisteredFn } from "./index.ts";
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

type AIOptions = {
  /** `toAITools` includes it (by default). The agent door is opt-in: exposed for your UI doesn't mean a tool. */
  tool?: boolean;
  /** What the model reads to decide when to call it. Optional, but models pick tools better with one. */
  description?: string;
};

/**
 * What this adapter reads from a function's `meta` (not a listener's). Add it to your meta shape:
 * `init<{ meta: AIMeta & AppMeta }>()`, then `meta: { ai: { tool: true, description: "Use when the customer asks to cancel an order" } }`.
 */
export type AIMeta = ForFunctions<{ ai?: AIOptions }>;

interface ErrorOption {
  /** Unexpected (non-domain) errors. The model only sees "internal_error". Default: console.error. */
  onError?: (error: unknown) => void;
}
export interface AIToolOptions extends ErrorOption {
  /** Overrides `meta.ai.description` for this tool. */
  description?: string;
}
export interface AIToolsOptions extends ErrorOption {
  /** Which exposed functions become tools. Default: those with `meta: { ai: { tool: true } }`. */
  filter?: (fn: RegisteredFn) => boolean;
  /** Each tool's description, when it isn't in `meta.ai.description`: `(f) => f.fn.meta?.summary`. Wins over meta. */
  describe?: (fn: RegisteredFn) => string | undefined;
}

/** `meta.ai` as `AIMeta` types it where you write it (meta is stored loose). */
const aiMeta = (fn: { meta?: Readonly<Record<string, unknown>> }) => fn.meta?.ai as AIOptions | undefined;

const isExposed = (fn: Fn): fn is ExposedFn => fn.expose === true;

/** What a function without input looks like to the model: an object with nothing in it. It sends `{}`, which run ignores. */
const noInput = jsonSchema({ type: "object", properties: {}, additionalProperties: false });

/**
 * One exposed function as an AI SDK tool, run as `caller`: the agent goes through the same policy,
 * validation, transaction and events as your HTTP API. You name it, like any AI SDK tool.
 *
 * ```ts
 * const caller = registry.as(await scopeFrom(request));
 * await generateText({ model, prompt, tools: { confirmBooking: toAITool(caller, bookings.confirm) } });
 * ```
 *
 * Domain errors reach the model (it sees the code and can react). Anything unexpected is reported
 * to `onError` and the model gets "internal_error", so internals never land in its context.
 */
export function toAITool<F extends ExposedFn>(
  caller: Caller<object>,
  fn: F,
  options: AIToolOptions = {},
): Tool<FnIn<F>, FnOut<F>> {
  const onError = options.onError ?? ((e) => console.error("[logic-sdk] tool failed unexpectedly", e));
  if (fn.expose !== true) throw new Error("[logic-sdk] toAITool needs a function with expose: true.");
  return tool({
    description: options.description ?? aiMeta(fn)?.description,
    inputSchema: fn.input ?? noInput,
    outputSchema: fn.output,
    async execute(input, { abortSignal }) {
      try {
        return await caller.run(fn, input, { signal: abortSignal });
      } catch (e) {
        if (isDomainError(e)) throw e;
        onError(e);
        throw new Error("internal_error");
      }
    },
  }) as Tool<FnIn<F>, FnOut<F>>;
}

/**
 * Exposed functions as AI SDK tools named `<module>_<function>`: by default the ones marked `meta: { ai: { tool: true } }`.
 *
 * ```ts
 * tools: toAITools(registry, caller)
 * ```
 */
export function toAITools<S extends object, Mods extends Record<string, object>>(
  registry: Registry<S, Mods>,
  caller: Caller<S>,
  options: AIToolsOptions = {},
): Partial<AIToolsOf<Mods>> {
  const filter = options.filter ?? ((f: RegisteredFn) => aiMeta(f.fn)?.tool === true);
  const tools: Record<string, Tool> = {};
  for (const f of registry.definitions.functions)
    if (isExposed(f.fn) && filter(f))
      tools[`${f.module}_${f.name}`] = toAITool(caller, f.fn, { onError: options.onError, description: options.describe?.(f) });
  return tools as Partial<AIToolsOf<Mods>>;
}
