import type { Database, DB } from "@aerowise/db";
import { sql, type RawBuilder, type Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

// One "next due" date per site. A contract's calendar spaces its visits evenly from the
// contract's start, while the authority counts its interval from the day of the last
// inspection, which is usually earlier. The site's next open inspection visit takes the
// earlier of the two, so the Due list, the schedule, the technician's stop and the inbox all
// show the date that actually counts. Authorities that count visits from the contract's start
// (Hays 10.V.2) keep the contract's calendar: that is their schedule.

/**
 * The authority's next due date for a site, as SQL: the one on its latest inspection filing, or
 * null when there is none or that authority keeps the contract's calendar. `org` and `site` are
 * ids (bound as parameters) or SQL references to them.
 */
const latestNextDueOn = (org: string | RawBuilder<unknown>, site: string | RawBuilder<unknown>) => sql<string | null>`(
  select case when r.rules -> 'service' ? 'contractVisits' then null else f.next_due_on end
  from filings f
  join jurisdiction_rulesets r on r.id = f.ruleset_id
  where f.organization_id = ${org} and f.site_id = ${site} and f.kind = 'inspection_report' and f.next_due_on is not null
  order by f.created_at desc
  limit 1)`;

/**
 * Moves the site's next open inspection visit forward to the authority's next due date from its
 * latest filing, when the contract had it later; its window ends there too. Runs in the
 * transaction that opens or rechecks a filing. Returns what moved, or null.
 */
export async function pullNextVisitForward(trx: Executor, a: { organizationId: string; siteId: string }) {
  const latest = await sql<{ nextDueOn: string | null }>`select ${latestNextDueOn(a.organizationId, a.siteId)}::text as "nextDueOn"`.execute(trx);
  const nextDueOn = latest.rows[0]?.nextDueOn ?? null;
  if (!nextDueOn) return null;
  const next = await trx
    .selectFrom("serviceObligations")
    .select(["id", "sequence", "dueOn", "windowStart", "windowEnd"])
    .where("organizationId", "=", a.organizationId)
    .where("siteId", "=", a.siteId)
    .where("serviceType", "=", "aerobic_inspection")
    .where("status", "=", "open")
    .orderBy("dueOn")
    .orderBy("id")
    .limit(1)
    .forUpdate()
    .executeTakeFirst();
  if (!next || next.dueOn <= nextDueOn) return null;
  const windowEnd = next.windowEnd < nextDueOn ? next.windowEnd : nextDueOn;
  const windowStart = next.windowStart < windowEnd ? next.windowStart : windowEnd;
  await trx
    .updateTable("serviceObligations")
    .set({ dueOn: nextDueOn, windowStart, windowEnd, updatedAt: new Date() })
    .where("organizationId", "=", a.organizationId)
    .where("id", "=", next.id)
    .execute();
  return { obligationId: next.id, sequence: next.sequence, from: next.dueOn, to: nextDueOn };
}

/**
 * The day a visit must be done by, as SQL over the service_obligations alias `o`: its due date,
 * or for the site's next open inspection visit the authority's next due date when that is
 * earlier. Visits made after the latest filing was opened (a renewal's, say) are covered here.
 */
export function visitDeadline(o = "o") {
  const v = sql.raw(o);
  return sql<string>`least(${v}.due_on, case
    when ${v}.service_type = 'aerobic_inspection' and ${v}.status = 'open' and not exists (
      select 1 from service_obligations p
      where p.organization_id = ${v}.organization_id and p.site_id = ${v}.site_id and p.service_type = 'aerobic_inspection'
        and p.status = 'open' and (p.due_on, p.id) < (${v}.due_on, ${v}.id))
    then ${latestNextDueOn(sql.raw(`${o}.organization_id`), sql.raw(`${o}.site_id`))}
  end)`;
}
