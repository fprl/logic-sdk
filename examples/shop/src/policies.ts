import type { Scope, SignedIn, System } from "./logic";

/** Who may call a function at all: plain sync checks over the scope, used as `authorize: signedIn`. */
export const anyone = () => true;
export const signedIn = (scope: Scope): scope is SignedIn => scope.user !== null;
export const staff = (scope: Scope): scope is SignedIn => scope.user?.role === "staff";
export const system = (scope: Scope): scope is System => "system" in scope;
/** Staff, or the system acting on its own (a cron). */
export const staffOrSystem = (scope: Scope) => staff(scope) || system(scope);
