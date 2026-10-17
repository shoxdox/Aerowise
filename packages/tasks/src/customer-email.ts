import type { Executor, PaymentProvider } from "@aerowise/payments";

// What every email to a homeowner shares: readable dates, replies that reach the provider,
// and payment wording that only promises what the provider can take.

/** A calendar date (YYYY-MM-DD, already in the company's time zone) as a letter writes it: "November 15, 2026". */
export const longDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/** The From line: the provider's name, at the platform's sending address. */
export const fromLine = (orgName: string, address: string) => `"${orgName.replace(/"/g, "")}" <${address}>`;

/** Where a homeowner's Reply goes: the provider's own email, never the platform's sending address. */
export const replyToOf = (orgEmail: string | null | undefined) => orgEmail?.trim() || null;

/**
 * Whether this company's customers can pay online now: its Stripe account takes charges and
 * the server has a payment provider. The pay page asks the same (`canPayOnline` in the API).
 * `provider` undefined means the caller was not told (a test or demo run): the company's own
 * Stripe status decides.
 */
export async function paysOnline(db: Executor, organizationId: string, provider?: PaymentProvider | null): Promise<boolean> {
  if (provider === null) return false;
  const o = await db.selectFrom("organizations").select(["stripeAccountId", "stripeChargesEnabled"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
  return !!o.stripeAccountId && o.stripeChargesEnabled;
}
