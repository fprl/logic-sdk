import type { Member, Role, Scope } from "./scope";

/**
 * Who may call a function at all. Plain sync functions over the scope, used as `authorize: staff`.
 * Type guards narrow `ctx.scope` in `handler`. Rules about one record go in `handler` (see bookings/data.ts).
 */
const role =
  (...roles: Role[]) =>
  (s: Scope): s is Member =>
    s.actor !== null && roles.includes(s.actor.role);

/** No sign-in needed: guests price stays and request bookings. */
export const anyone = () => true;
export const member = (s: Scope): s is Member => s.actor !== null;
export const staff = role("agent", "owner", "admin");
export const owner = role("owner", "admin");
export const agent = role("agent", "admin");
