import type { DB } from "@aerowise/db";
import { buildTermSchedule } from "@aerowise/domain";
import type { Transaction } from "kysely";

export interface Terms {
  planId: string | null;
  planName: string;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: DB["contracts"]["billingFrequency"];
  serviceType: DB["contracts"]["serviceType"];
}

/**
 * Inserts a contract and one open obligation per visit window, in the caller's
 * transaction. Postgres errors (overlapping dates, a second renewal) are left to the caller.
 */
export async function insertContract(
  trx: Transaction<DB>,
  organizationId: string,
  input: { siteId: string; startOn: string; terms: Terms; autoRenew: boolean; notes?: string | null; previousContractId?: string; signedDocumentId?: string | null },
) {
  const schedule = buildTermSchedule(input.startOn, input.terms.termMonths, input.terms.visitsPerTerm);
  const created = await trx
    .insertInto("contracts")
    .values({
      organizationId,
      siteId: input.siteId,
      ...input.terms,
      startOn: input.startOn,
      endOn: schedule.endOn,
      autoRenew: input.autoRenew,
      notes: input.notes ?? null,
      previousContractId: input.previousContractId ?? null,
      signedDocumentId: input.signedDocumentId ?? null,
      cancelledAt: null,
      cancelReason: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("serviceObligations")
    .values(
      schedule.visits.map((v) => ({
        organizationId,
        contractId: created.id,
        siteId: input.siteId,
        serviceType: input.terms.serviceType,
        sequence: v.sequence,
        windowStart: v.windowStart,
        windowEnd: v.windowEnd,
        dueOn: v.dueOn,
        completedAt: null,
      })),
    )
    .execute();
  return created.id;
}
