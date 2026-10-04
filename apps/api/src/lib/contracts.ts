import type { DB } from "@aerowise/db";
import { buildTermSchedule } from "@aerowise/domain";
import type { Transaction } from "kysely";
import { HttpError } from "./errors.ts";

export interface Terms {
  planId: string | null;
  planName: string;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: DB["contracts"]["billingFrequency"];
  serviceType: DB["contracts"]["serviceType"];
}

/** Maps Postgres constraint errors on contracts to API errors. */
export function contractConflict(err: unknown): never {
  const code = (err as { code?: string }).code;
  const constraint = (err as { constraint?: string }).constraint ?? "";
  if (code === "23P01") throw new HttpError(409, "overlapping_contract", "This site already has a contract covering those dates");
  if (code === "23505" && constraint.includes("previous_contract_id")) {
    throw new HttpError(409, "already_renewed", "This contract has already been renewed");
  }
  throw err;
}

/** Inserts a contract and one open obligation per visit window, in the caller's transaction. */
export async function insertContract(
  trx: Transaction<DB>,
  organizationId: string,
  input: { siteId: string; startOn: string; terms: Terms; autoRenew: boolean; notes?: string | null; previousContractId?: string },
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
      cancelledAt: null,
      cancelReason: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
    .catch(contractConflict);
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
