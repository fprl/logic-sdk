import type { Scope, SignedIn } from "./logic";

/** Who may call a function at all: plain sync checks over the scope, used as `authorize: signedIn`. */
export const anyone = () => true;
export const signedIn = (scope: Scope): scope is SignedIn => scope.user !== null;
export const staff = (scope: Scope): scope is SignedIn => scope.user?.role === "staff";
