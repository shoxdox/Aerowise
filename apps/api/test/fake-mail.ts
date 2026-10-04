import type { EmailMessage, EmailResult, EmailTransport } from "@aerowise/compliance";

/**
 * A mail provider double. It honours idempotency keys like a real provider must, and can
 * be told to fail, or to deliver and then lose the response (the worst case for retries).
 */
export class FakeMail implements EmailTransport {
  readonly name = "fake";
  delivered = new Map<string, EmailMessage>();
  calls = 0;
  mode: "ok" | "fail" | "lose_response_once" = "ok";

  async send(m: EmailMessage): Promise<EmailResult> {
    this.calls++;
    if (this.mode === "fail") throw new Error("SMTP 451 temporary failure");
    if (!this.delivered.has(m.idempotencyKey)) this.delivered.set(m.idempotencyKey, m);
    if (this.mode === "lose_response_once") {
      this.mode = "ok";
      throw new Error("timed out waiting for the provider");
    }
    return { messageId: `<${m.idempotencyKey}@fake>`, acceptedAt: new Date().toISOString(), response: { fake: true } };
  }
}
