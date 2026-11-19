import * as catalog from "../catalog";
import * as orders from "../orders";
import { buy, cancel } from "./actions";
import { Assistant } from "./assistant";
import { caller } from "./caller";

export const dynamic = "force-dynamic";

const euros = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const shop = caller();
  const products = await shop.run(catalog.list, undefined);
  const mine = await shop.run(orders.mine, undefined);

  return (
    <main>
      <h1>Logic shop</h1>
      <p>Signed in as ana. Every button and the assistant run the same functions as the HTTP API.</p>
      {error && <p className="error">{error}</p>}

      <h2>Products</h2>
      <ul>
        {products.map((p) => (
          <li key={p.sku}>
            <span>
              {p.name} · {euros(p.price)} · {p.stock} left
            </span>
            <form action={buy}>
              <input type="hidden" name="sku" value={p.sku} />
              <button>Buy one</button>
            </form>
          </li>
        ))}
      </ul>

      <h2>Your orders</h2>
      {mine.length === 0 && <p>Nothing yet.</p>}
      <ul>
        {mine.map((o) => (
          <li key={o.id}>
            <span>
              {o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")} · {euros(o.total)} · {o.status}
            </span>
            {/* The same canCancel rule the mutation checks */}
            {o.can.cancel && (
              <form action={cancel}>
                <input type="hidden" name="orderId" value={o.id} />
                <button>Cancel</button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <h2>Ask the assistant</h2>
      <Assistant />
    </main>
  );
}
