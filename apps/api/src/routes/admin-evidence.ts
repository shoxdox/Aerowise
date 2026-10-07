import { loadCatalog, rulesetOn, type CatalogEntry } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { CALL_SHEET_SHARED_QUESTION, renderCallSheet, type CallSheetQuestion } from "@aerowise/reports";
import {
  ACCEPTANCE_TOPICS,
  ANSWER_OUTCOME_LABELS,
  EVIDENCE_CLASS_LABELS,
  EVIDENCE_KIND_LABELS,
  authorityEvidence,
  authorityEvidenceInput,
  buildRulesetProposal,
  evidenceClass,
  ProposalError,
  profileStatus,
  QUESTION_STATE_LABELS,
  QUESTION_TOPIC_LABELS,
  questionState,
  rulesetEvidencePage,
  rulesetProposal,
  rulesetProposalInput,
  verifiedWith,
  type AuthorityEvidence,
  type EvidenceAnswer,
  type QuestionState,
  type QuestionTopic,
} from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound, unprocessable } from "../lib/errors.ts";
import { platformAudit } from "../lib/platform-audit.ts";

const keyParams = z.object({ key: z.string().regex(/^[a-z0-9-]{2,63}$/) });

/**
 * W12.1: evidence about an authority's requirements, per open question, for platform
 * admins. Recording evidence never changes a ruleset; the proposal prepares the next
 * version and its diff for a reviewed pull request and writes nothing but an audit event.
 */
export const adminEvidenceRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  const today = () => now().toISOString().slice(0, 10);

  async function authority(key: string): Promise<CatalogEntry & { newest: CatalogEntry["rulesets"][number] }> {
    const entry = (await loadCatalog(db)).find((e) => e.jurisdiction.key === key);
    const newest = entry?.rulesets[0];
    if (!entry || !newest) throw notFound("Authority");
    return { ...entry, newest };
  }

  async function loadEvidence(jurisdictionId: string): Promise<AuthorityEvidence[]> {
    const rows = await db
      .selectFrom("authorityEvidence as e")
      .innerJoin("platformAdmins as p", "p.id", "e.recordedBy")
      .selectAll("e")
      .select("p.name as recordedByName")
      .where("e.jurisdictionId", "=", jurisdictionId)
      .orderBy("e.obtainedOn", "desc")
      .orderBy("e.createdAt", "desc")
      .execute();
    const answers = rows.length
      ? await db
          .selectFrom("authorityEvidenceAnswers")
          .selectAll()
          .where(
            "evidenceId",
            "in",
            rows.map((r) => r.id),
          )
          .orderBy("position")
          .execute()
      : [];
    return rows.map((r) => {
      const obtainedOn = typeof r.obtainedOn === "string" ? r.obtainedOn : new Date(r.obtainedOn).toISOString().slice(0, 10);
      return {
        id: r.id,
        kind: r.kind,
        evidenceClass: evidenceClass(r.kind),
        obtainedOn,
        rulesetVersion: r.rulesetVersion,
        contactName: r.contactName,
        contactRole: r.contactRole,
        contactOrganization: r.contactOrganization,
        contactDetail: r.contactDetail,
        references: r.references,
        note: r.note,
        recordedBy: r.recordedByName,
        createdAt: r.createdAt.toISOString(),
        answers: answers
          .filter((a) => a.evidenceId === r.id)
          .map((a) => ({
            id: a.id,
            evidenceId: r.id,
            question: a.question,
            unresolvedItem: a.unresolvedItem,
            topic: a.topic as QuestionTopic,
            field: a.field,
            answer: a.answer,
            outcome: a.outcome,
            kind: r.kind,
            evidenceClass: evidenceClass(r.kind),
            obtainedOn,
            contactName: r.contactName,
            contactOrganization: r.contactOrganization,
          })),
      };
    });
  }

  async function page(key: string) {
    const a = await authority(key);
    const rules = a.newest.rules;
    const evidence = await loadEvidence(a.jurisdiction.id);
    const answers: EvidenceAnswer[] = evidence.flatMap((e) => e.answers);
    const unresolved = rules.profile?.unresolved ?? [];
    const forItem = (item: string) => answers.filter((x) => x.unresolvedItem === item);
    const forTopic = (topic: QuestionTopic) => answers.filter((x) => x.topic === topic);
    return {
      key: a.jurisdiction.key,
      authorityName: a.jurisdiction.authorityName,
      profileStatus: profileStatus(rules),
      verified: verifiedWith(rules),
      version: a.newest.version,
      effectiveFrom: a.newest.effectiveFrom,
      versionInForce: rulesetOn(a, today())?.version ?? null,
      today: today(),
      unresolved: unresolved.map((item) => ({ item, state: questionState(forItem(item)), answers: forItem(item) })),
      acceptance: ACCEPTANCE_TOPICS.map((topic) => ({ topic, label: QUESTION_TOPIC_LABELS[topic], state: questionState(forTopic(topic)), answers: forTopic(topic) })),
      otherAnswers: answers.filter((x) => !x.unresolvedItem || !unresolved.includes(x.unresolvedItem)),
      evidence,
    };
  }

  app.get(
    "/admin/rulesets/:key",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "One authority's open questions, acceptance questions and recorded evidence",
        params: keyParams,
        response: { 200: rulesetEvidencePage },
      },
    },
    async (req) => page(req.params.key),
  );

  app.get(
    "/admin/rulesets/:key/call-sheet.pdf",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "A printable call sheet of this authority's open and acceptance questions, with the dated evidence on record. Read-only; names no contact and claims no acceptance.",
        params: keyParams,
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const a = await authority(req.params.key);
      const rules = a.newest.rules;
      if (profileStatus(rules) === "fictional") throw unprocessable("Example rules are fictional: there is no authority to ask.");
      const p = await page(req.params.key);
      const admin = await db.selectFrom("platformAdmins").select("name").where("id", "=", adminId).executeTakeFirst();
      const references = new Map(p.evidence.map((e) => [e.id, e.references]));
      // Each answer on record, dated and attributed, so the sheet says where it came from.
      const onRecord = (answers: EvidenceAnswer[]) =>
        answers.map((x) => {
          const refs = references.get(x.evidenceId) ?? [];
          return [
            `${x.obtainedOn}, ${EVIDENCE_CLASS_LABELS[x.evidenceClass]} (${EVIDENCE_KIND_LABELS[x.kind].toLowerCase()}${x.contactOrganization ? `, ${x.contactOrganization}` : ""}): ${ANSWER_OUTCOME_LABELS[x.outcome]}. ${x.answer}`,
            refs.length ? ` Sources: ${refs.join("; ")}` : "",
          ].join("");
        });
      const q = (text: string, state: QuestionState, answers: EvidenceAnswer[]): CallSheetQuestion => ({ text, state: QUESTION_STATE_LABELS[state], evidence: onRecord(answers) });
      const at = now();
      const pdf = await renderCallSheet({
        authorityName: p.authorityName,
        key: p.key,
        statusLabel: p.verified ? "Verified" : "Draft",
        verified: p.verified !== null,
        version: p.version,
        versionInForce: p.versionInForce,
        sourcesCheckedOn: rules.profile?.sourcesCheckedOn ?? null,
        requirementEffective: rules.profile?.requirementEffective ?? null,
        sources: rules.profile?.sources ?? [],
        open: p.unresolved.map((u) => q(u.item, u.state, u.answers)),
        acceptance: p.acceptance.map((x) => q(x.label, x.state, x.answers)),
        sharedQuestion: CALL_SHEET_SHARED_QUESTION,
        generatedOn: p.today,
        generatedAt: at.toISOString(),
        preparedBy: admin?.name ?? "a platform admin",
      });
      return reply
        .type("application/pdf")
        .header("content-disposition", `inline; filename="aerowise-call-sheet-${p.key}-${p.today}.pdf"`)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .send(pdf);
    },
  );

  app.post(
    "/admin/rulesets/:key/evidence",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Record dated evidence and its answers. Never changes the ruleset.",
        params: keyParams,
        body: authorityEvidenceInput,
        response: { 201: authorityEvidence },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const a = await authority(req.params.key);
      const input = req.body;
      if (input.obtainedOn > today()) throw unprocessable("The evidence cannot be dated in the future.");
      // An answer names an open question only word for word, from any published version.
      const known = new Set(a.rulesets.flatMap((r) => r.rules.profile?.unresolved ?? []));
      const stray = input.answers.find((x) => x.unresolvedItem && !known.has(x.unresolvedItem));
      if (stray) throw unprocessable("An answer names an open question this authority's rulesets do not list.");

      const id = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("authorityEvidence")
          .values({
            jurisdictionId: a.jurisdiction.id,
            rulesetVersion: a.newest.version,
            kind: input.kind,
            obtainedOn: input.obtainedOn,
            contactName: input.contactName,
            contactRole: input.contactRole,
            contactOrganization: input.contactOrganization,
            contactDetail: input.contactDetail,
            references: input.references,
            note: input.note,
            recordedBy: adminId,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("authorityEvidenceAnswers")
          .values(input.answers.map((x, position) => ({ evidenceId: row.id, position, ...x })))
          .execute();
        await platformAudit(trx, req, {
          adminId,
          action: "authority_evidence.recorded",
          entityType: "authority_evidence",
          entityId: row.id,
          changes: { key: a.jurisdiction.key, kind: input.kind, obtainedOn: input.obtainedOn, answers: input.answers.length },
        });
        return row.id;
      });
      const saved = (await loadEvidence(a.jurisdiction.id)).find((e) => e.id === id)!;
      return reply.status(201).send(saved);
    },
  );

  app.post(
    "/admin/rulesets/:key/proposal",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Prepare the next ruleset version and its diff from recorded answers, for a reviewed pull request. Publishes nothing.",
        params: keyParams,
        body: rulesetProposalInput,
        response: { 200: rulesetProposal },
      },
    },
    async (req) => {
      const { adminId } = req.requireAdmin();
      const a = await authority(req.params.key);
      const answers = (await loadEvidence(a.jurisdiction.id)).flatMap((e) => e.answers);
      let proposal;
      try {
        proposal = buildRulesetProposal(a.newest.rules, answers, req.body);
      } catch (err) {
        if (err instanceof ProposalError) throw unprocessable(err.message);
        throw err;
      }
      await platformAudit(db, req, {
        adminId,
        action: "ruleset.proposal_prepared",
        entityType: "jurisdiction",
        entityId: a.jurisdiction.id,
        changes: { key: proposal.key, version: proposal.version, verified: proposal.verified, closes: proposal.closes.length, answerIds: req.body.answerIds },
      });
      return proposal;
    },
  );
};
