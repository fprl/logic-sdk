"use client";

import { useActionState } from "react";
import { ask } from "./actions";

export function Assistant() {
  const [answer, action, pending] = useActionState(ask, null);
  return (
    <form action={action}>
      <textarea name="prompt" rows={2} defaultValue="Order two mugs and a tee, please." />
      <button disabled={pending}>{pending ? "Thinking..." : "Ask"}</button>
      {answer && <p className="answer">{answer}</p>}
    </form>
  );
}
