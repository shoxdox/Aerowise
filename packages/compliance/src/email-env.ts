import type { Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { OutboxTransport, type EmailTransport } from "./email.ts";
import { ProviderTransport, type EmailProvider } from "./email-provider.ts";
import { ResendEmailProvider } from "./resend.ts";

/**
 * Email as the environment configures it: Resend when RESEND_API_KEY is set, the
 * development outbox in file storage otherwise. EMAIL_REDIRECT_TO sends every message to
 * one test inbox instead (staging). Resend's webhooks reach `<PUBLIC_APP_URL>/api/webhooks/email`.
 */
export function emailFromEnv(
  db: Database,
  store: ObjectStore,
  env: Record<string, string | undefined>,
  now: () => Date = () => new Date(),
): { transport: EmailTransport; provider: EmailProvider | null } {
  if (env.RESEND_API_KEY) {
    const provider = new ResendEmailProvider({
      apiKey: env.RESEND_API_KEY,
      webhookSecrets: (env.RESEND_WEBHOOK_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    });
    return { transport: new ProviderTransport(db, provider, now, { redirectTo: env.EMAIL_REDIRECT_TO || undefined }), provider };
  }
  return { transport: new OutboxTransport(store, now), provider: null };
}
