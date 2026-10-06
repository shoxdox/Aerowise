import type { Database } from "@aerowise/db";
import { CONFIRMATION_TOPICS, evidenceClass, fieldConfirmations, type EvidenceAnswered, type FieldConfirmation } from "@aerowise/domain";

/**
 * W12.V4: each authority's confirmation fields (where reports go and the acceptance
 * questions) from the evidence log, keyed by jurisdiction id. An authority with nothing
 * recorded is absent; `confirmationsFor` fills it in as all open.
 */
export async function loadConfirmations(db: Database, jurisdictionId?: string): Promise<Map<string, FieldConfirmation[]>> {
  let q = db
    .selectFrom("authorityEvidenceAnswers as a")
    .innerJoin("authorityEvidence as e", "e.id", "a.evidenceId")
    .select(["e.jurisdictionId", "e.kind", "e.obtainedOn", "a.topic", "a.outcome"])
    .where("a.topic", "in", [...CONFIRMATION_TOPICS]);
  if (jurisdictionId) q = q.where("e.jurisdictionId", "=", jurisdictionId);
  const byAuthority = new Map<string, EvidenceAnswered[]>();
  for (const r of await q.execute()) {
    const list = byAuthority.get(r.jurisdictionId) ?? [];
    list.push({
      topic: r.topic as EvidenceAnswered["topic"],
      outcome: r.outcome,
      evidenceClass: evidenceClass(r.kind),
      obtainedOn: typeof r.obtainedOn === "string" ? r.obtainedOn : new Date(r.obtainedOn).toISOString().slice(0, 10),
    });
    byAuthority.set(r.jurisdictionId, list);
  }
  return new Map([...byAuthority].map(([id, answers]) => [id, fieldConfirmations(answers)]));
}

export function confirmationsFor(map: Map<string, FieldConfirmation[]>, jurisdictionId: string): FieldConfirmation[] {
  return map.get(jurisdictionId) ?? fieldConfirmations([]);
}
