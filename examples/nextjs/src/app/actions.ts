"use server";

import { anthropic } from "@ai-sdk/anthropic";
import { isDomainError } from "logic-sdk";
import { toAITools } from "logic-sdk/ai";
import { generateText, isStepCount } from "ai";
import * as bookings from "example-node/bookings";
import * as properties from "example-node/properties";
import { registry, staffCaller } from "@/lib/caller";

export type Result = { ok: boolean; text: string };

/** Demo data: a property and a pending booking. */
export async function seed(): Promise<Result> {
  const caller = staffCaller();
  const owner = caller.with({ actor: { id: "owner_1", role: "owner" } });
  const property = await owner.run(properties.create, {
    name: "Casa Azul",
    nightlyRate: 120_00,
    cleaningFee: 60_00,
    minNights: 2,
  });
  const booking = await caller.with({ actor: null }).run(bookings.request, {
    propertyId: property.id,
    checkIn: "2026-12-20",
    checkOut: "2026-12-24",
    guestEmail: "ana@example.com",
  });
  return { ok: true, text: booking.id };
}

/** Path 1: a Server Action, the way a staff UI calls it. */
export async function confirmFromForm(_: Result | null, form: FormData): Promise<Result> {
  try {
    const booking = await staffCaller().run(bookings.confirm, {
      bookingId: String(form.get("bookingId")),
    });
    return { ok: true, text: `Booking ${booking.id} is ${booking.status}.` };
  } catch (error) {
    if (isDomainError(error)) return { ok: false, text: error.message };
    throw error;
  }
}

/** Path 2: an agent, with the same functions as tools, the same caller and the same rules. */
export async function askAgent(_: Result | null, form: FormData): Promise<Result> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, text: "Set ANTHROPIC_API_KEY to talk to the agent." };
  }

  const tools = toAITools(registry, staffCaller(), {
    // Agents may read and confirm, but never charge a card
    filter: (f) => f.id !== "bookings.checkout",
  });

  const result = await generateText({
    model: anthropic("claude-opus-5-5"),
    system: "You help hotel staff manage bookings. Use the tools; never guess ids or prices.",
    prompt: String(form.get("prompt")),
    tools,
    stopWhen: isStepCount(5),
  });

  const calls = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
  return { ok: true, text: `${result.text}\n\nTools used: ${calls.join(", ") || "none"}` };
}
