export interface Mailer {
  send(message: { to: string; subject: string; locale: string }): Promise<void>;
}
export interface Payments {
  charge(input: { amount: number; reference: string }): Promise<{ chargeId: string }>;
  refund(chargeId: string): Promise<void>;
}
export type Services = { mailer: Mailer; payments: Payments };

export function memoryMailer() {
  const sent: { to: string; subject: string; locale: string }[] = [];
  return { sent, async send(m: (typeof sent)[number]) { sent.push(m); } } satisfies Mailer & { sent: unknown };
}
export function memoryPayments() {
  const charges = new Map<string, { amount: number; refunded: boolean }>();
  return {
    charges,
    async charge({ amount }: { amount: number }) {
      const chargeId = `ch_${charges.size + 1}`;
      charges.set(chargeId, { amount, refunded: false });
      return { chargeId };
    },
    async refund(chargeId: string) { charges.get(chargeId)!.refunded = true; },
  } satisfies Payments & { charges: unknown };
}
