import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import type { Transaction } from "kysely";
import type { CustomerPayload } from "./types.ts";

type Executor = Database | Transaction<DB>;

export const payloadHash = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

/**
 * What QuickBooks should say about each customer: their name, the billing address, and
 * the email and phone of their primary contact (else billing, else any contact).
 */
export async function customerPayloads(db: Executor, organizationId: string, customerIds: string[]): Promise<Map<string, CustomerPayload>> {
  const out = new Map<string, CustomerPayload>();
  if (!customerIds.length) return out;
  const customers = await db
    .selectFrom("customers")
    .select(["id", "displayName", "billingLine1", "billingLine2", "billingCity", "billingState", "billingPostalCode"])
    .where("organizationId", "=", organizationId)
    .where("id", "in", customerIds)
    .execute();
  const contacts = await db
    .selectFrom("contacts")
    .select(["customerId", "email", "phone", "type", "createdAt"])
    .where("organizationId", "=", organizationId)
    .where("customerId", "in", customerIds)
    .orderBy("createdAt")
    .execute();
  const rank = (t: string) => (t === "primary" ? 0 : t === "billing" ? 1 : 2);
  contacts.sort((a, b) => rank(a.type) - rank(b.type));
  for (const c of customers) {
    const mine = contacts.filter((k) => k.customerId === c.id);
    const hasAddress = c.billingLine1 || c.billingCity || c.billingPostalCode;
    out.set(c.id, {
      displayName: c.displayName,
      email: mine.find((k) => k.email)?.email ?? null,
      phone: mine.find((k) => k.phone)?.phone ?? null,
      address: hasAddress ? { line1: c.billingLine1, line2: c.billingLine2, city: c.billingCity, state: c.billingState, postalCode: c.billingPostalCode } : null,
    });
  }
  return out;
}
