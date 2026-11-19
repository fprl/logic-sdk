import { db } from "example-node/db";
import { makeRegistry } from "example-node/registry";
import type { Scope } from "example-node/scope";
import { memoryMailer, memoryPayments } from "example-node/services";

// One registry for the server, like any long-lived Node process.
export const registry = makeRegistry(db, { mailer: memoryMailer(), payments: memoryPayments() });

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
