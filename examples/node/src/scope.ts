export type Role = "guest" | "agent" | "owner" | "admin";
export type Actor = { id: string; role: Role };

type Base = { accountId: string; locale: string; requestId: string };
/** Nobody signed in: a guest browsing, pricing a stay, requesting a booking. */
export type Anonymous = Base & { actor: null };
/** Someone signed in. Policies in policies.ts narrow `ctx.scope` to this. */
export type Member = Base & { actor: Actor };

/** Who is calling. Your app's own type: the library only passes it along. Plain JSON: it travels with events. */
export type Scope = Anonymous | Member;
