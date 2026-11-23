import { jsonSchema, tool, type Tool } from "ai";
import { isDomainError, type Caller, type FnIn, type FnOut, type ForFunctions, type PublishableFn } from "./index.ts";

/**
 * What this adapter reads from a function's `meta` (not a listener's). Add it to your meta shape:
 * `init<{ meta: AIMeta & AppMeta }>()`, then `meta: { ai: { description: "Use when the customer asks to cancel an order" } }`.
 */
export type AIMeta = ForFunctions<{
  ai?: {
    /** What the model reads to decide when to call it. Optional, but models pick tools better with one. */
    description?: string;
  };
}>;

export interface AIToolOptions {
  /** Overrides `meta.ai.description` for this tool. */
  description?: string;
  /** Unexpected (non-domain) errors. The model only sees "internal_error". Default: console.error. */
  onError?: (error: unknown) => void;
}

/** `meta.ai` as `AIMeta` types it where you write it (meta is stored loose). */
const aiMeta = (fn: { meta?: Readonly<Record<string, unknown>> }) => fn.meta?.ai as { description?: string } | undefined;

/** What a function without input looks like to the model: an object with nothing in it. It sends `{}`, which run ignores. */
const noInput = jsonSchema({ type: "object", properties: {}, additionalProperties: false });

/**
 * One function as an AI SDK tool, run as `caller`: the agent goes through the same policy, validation, transaction
 * and events as your HTTP API. You name it, like any AI SDK tool, and list the ones an agent gets. It needs
 * `authorize`: the model acts for someone else.
 *
 * ```ts
 * const caller = registry.as(await scopeFrom(request));
 * await generateText({ model, prompt, tools: { confirmBooking: toAITool(caller, bookings.confirm) } });
 * ```
 *
 * Domain errors reach the model (it sees the code and can react). Anything unexpected is reported
 * to `onError` and the model gets "internal_error", so internals never land in its context.
 */
export function toAITool<F extends PublishableFn>(
  caller: Caller<object>,
  fn: F,
  options: AIToolOptions = {},
): Tool<FnIn<F>, FnOut<F>> {
  const onError = options.onError ?? ((e) => console.error("[logic-sdk] tool failed unexpectedly", e));
  if (!fn.authorize) throw new Error("[logic-sdk] toAITool publishes a function, so it needs authorize: say who may call it (everyone is `authorize: anyone`).");
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
