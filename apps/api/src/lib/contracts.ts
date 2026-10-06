import type { DB } from "@aerowise/db";
import { insertContract as insertContractRows, MoreVisitsRequired, type Terms } from "@aerowise/renewals";
import type { Transaction } from "kysely";
import { HttpError } from "./errors.ts";

export type { Terms };

/** Maps Postgres constraint errors on contracts to API errors. */
export function contractConflict(err: unknown): never {
  if (err instanceof MoreVisitsRequired) throw new HttpError(409, "more_visits_required", err.message);
  const code = (err as { code?: string }).code;
  const constraint = (err as { constraint?: string }).constraint ?? "";
  if (code === "23P01") throw new HttpError(409, "overlapping_contract", "This site already has a contract covering those dates");
  if (code === "23505" && constraint.includes("previous_contract_id")) {
    throw new HttpError(409, "already_renewed", "This contract has already been renewed");
  }
  throw err;
}

/** Inserts a contract and one open obligation per visit window, in the caller's transaction. Visits follow the site's authority. */
export async function insertContract(trx: Transaction<DB>, organizationId: string, input: Parameters<typeof insertContractRows>[2], opts?: Parameters<typeof insertContractRows>[3]) {
  return insertContractRows(trx, organizationId, input, opts).catch(contractConflict);
}
