import { after } from "next/server";
import { db } from "example-node/db";
import { makeRegistry } from "example-node/registry";
import type { Scope } from "example-node/scope";
import { memoryMailer, memoryPayments } from "example-node/services";

// One registry and one pool for the server, at module scope, like any long-lived Node process.
export const registry = makeRegistry(
  db,
  { mailer: memoryMailer(), payments: memoryPayments() },
  // Listeners (the guest email, the ops task) run after the response is sent. `after` is Next's waitUntil.
  { waitUntil: (p) => after(() => p) },
);

// Demo auth: everyone is a staff agent. Put your real session lookup here.
export function staffCaller() {
  const scope: Scope = {
    actor: { id: "agent_1", role: "agent" },
    accountId: "acc_demo",
    locale: "en",
    requestId: crypto.randomUUID(),
  };
  return registry.as(scope);
}
