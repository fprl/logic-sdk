import type { DatabaseAdapter } from "../src/index.ts";

/** A tiny transactional store for runtime-agnostic tests. Transactions work on a copy and swap it in on commit. */
export type Store = { rows: Record<string, any[]> };

export function memoryDatabase(store: Store = { rows: {} }): DatabaseAdapter<Store> & { store: Store } {
  return {
    store,
    db: store,
    transactions: "interactive",
    async transaction(fn) {
      const tx: Store = { rows: structuredClone(store.rows) };
      const result = await fn(tx);
      store.rows = tx.rows;
      return result;
    },
    nest: (tx) => memoryDatabase(tx),
  };
}
