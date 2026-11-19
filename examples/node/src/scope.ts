export type Role = "guest" | "agent" | "owner" | "admin";
export type Actor = { id: string; role: Role };

/** Who is calling. Your app's own type: the library only passes it along. */
export type Scope = {
  actor: Actor | null;
  accountId: string;
  locale: string;
  requestId: string;
};
/** A scope with someone signed in. Policies built on `is` narrow to this. */
export type Signed = Scope & { actor: Actor };

/** Plain function, not a method: scope travels with events, so it must stay JSON. */
export const is = (scope: Scope, ...roles: Role[]): scope is Signed => !!scope.actor && roles.includes(scope.actor.role);
