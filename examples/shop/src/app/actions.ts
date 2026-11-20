"use server";

import { anthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount } from "ai";
import { isDomainError } from "logic-sdk";
import { toAITool } from "logic-sdk/ai";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as catalog from "../catalog";
import * as orders from "../orders";
import { caller } from "./caller";

/** Path 1: Server Actions, the way your UI calls the shop. */
export async function buy(form: FormData) {
  await attempt(() => caller().run(orders.place, { items: [{ sku: String(form.get("sku")), quantity: 1 }] }));
}

export async function cancel(form: FormData) {
  await attempt(() => caller().run(orders.cancel, { orderId: String(form.get("orderId")) }));
}

/** Path 2: an agent, with the same functions as tools. Same caller, same rules, same transaction. */
export async function ask(_: string | null, form: FormData) {
  if (!process.env.ANTHROPIC_API_KEY) return "Set ANTHROPIC_API_KEY to talk to the assistant.";

  const shop = caller();
  const result = await generateText({
    model: anthropic("claude-opus-5-5"),
    system: "You help customers of a small shop. Use the tools; never guess skus or prices.",
    prompt: String(form.get("prompt")),
    // Only what you list: the agent can browse and order, nothing else
    tools: { listProducts: toAITool(shop, catalog.list), placeOrder: toAITool(shop, orders.place) },
    stopWhen: isStepCount(5),
  });

  revalidatePath("/");
  return result.text;
}

/** Run it, then show the page again. A rule saying no shows up as ?error=orders.too_many_items. */
async function attempt(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (!isDomainError(error)) throw error;
    redirect(`/?error=${error.code}`);
  }
  redirect("/");
}
