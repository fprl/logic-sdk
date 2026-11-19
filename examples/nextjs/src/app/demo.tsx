"use client";

import { useActionState, useState } from "react";
import { askAgent, confirmFromForm, seed, type Result } from "./actions";

export function Demo() {
  const [bookingId, setBookingId] = useState("");
  const [confirmed, confirm, confirming] = useActionState(confirmFromForm, null);
  const [answer, ask, asking] = useActionState(askAgent, null);

  return (
    <main>
      <h1>One function, two callers</h1>
      <p>
        A staff form and an AI agent both run <code>bookings.confirm</code>: same policy, same
        transaction, same events after commit.
      </p>

      <button type="button" onClick={async () => setBookingId((await seed()).text)}>
        Create a pending booking
      </button>
      {bookingId && <p>Pending booking: <code>{bookingId}</code></p>}

      <section>
        <h2>1. Server Action</h2>
        <form action={confirm}>
          <input name="bookingId" placeholder="Booking id" defaultValue={bookingId} key={bookingId} />
          <button disabled={confirming}>Confirm</button>
        </form>
        <Output result={confirmed} />
      </section>

      <section>
        <h2>2. Agent</h2>
        <form action={ask}>
          <textarea
            name="prompt"
            rows={3}
            defaultValue={bookingId ? `Confirm booking ${bookingId}` : ""}
            key={bookingId}
          />
          <button disabled={asking}>Ask the agent</button>
        </form>
        <Output result={answer} />
      </section>
    </main>
  );
}

function Output({ result }: { result: Result | null }) {
  if (!result) return null;
  return <pre className={result.ok ? "ok" : "error"}>{result.text}</pre>;
}
