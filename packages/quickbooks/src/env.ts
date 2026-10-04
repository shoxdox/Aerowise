import type { Database } from "@aerowise/db";
import { TokenCipher } from "./crypto.ts";
import { IntuitQuickBooksProvider } from "./intuit.ts";
import { TestQuickBooksProvider } from "./test-company.ts";
import type { QuickBooksProvider } from "./types.ts";

/**
 * QuickBooks as the environment configures it: Intuit when QUICKBOOKS_CLIENT_ID and
 * QUICKBOOKS_CLIENT_SECRET are set, the built-in test company otherwise (never in
 * production), or off.
 */
export function quickBooksFromEnv(
  db: Database,
  env: Record<string, string | undefined>,
  production: boolean,
  now: () => Date = () => new Date(),
): { provider: QuickBooksProvider; cipher: TokenCipher } | null {
  const key = env.QUICKBOOKS_TOKEN_KEY;
  if (env.QUICKBOOKS_CLIENT_ID && env.QUICKBOOKS_CLIENT_SECRET) {
    if (production && !key) throw new Error("QUICKBOOKS_TOKEN_KEY is required in production when QuickBooks is configured");
    const environment = env.QUICKBOOKS_ENVIRONMENT === "production" ? "production" : "sandbox";
    return { provider: new IntuitQuickBooksProvider({ clientId: env.QUICKBOOKS_CLIENT_ID, clientSecret: env.QUICKBOOKS_CLIENT_SECRET, environment }), cipher: new TokenCipher(key) };
  }
  if (production) return null;
  return { provider: new TestQuickBooksProvider(db, now), cipher: new TokenCipher(key) };
}
