import type { Database } from "@aerowise/db";
import {
  applyRequirements,
  DEFAULT_TEMPLATE,
  validateInspection,
  type InspectionValues,
  type RulesetRules,
  type SubmissionMethod,
  type TemplateDefinition,
} from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import type { EmailTransport } from "./email.ts";
import { requirementsOf, type ResolvedJurisdiction } from "./rulesets.ts";

/** A required field's name as the built-in form labels it. */
const fieldName = (key: string) => DEFAULT_TEMPLATE.definition.fields.find((f) => f.key === key)?.label ?? key;

// The JurisdictionAdapter interface from COMPLIANCE-ENGINE.md. An adapter turns a
// completed inspection into what one authority needs, using that authority's ruleset.

export interface SiteContext {
  siteId: string;
  county: string | null;
  state: string;
  permitNumber: string | null;
  customerType: "residential" | "commercial";
}

export interface Requirements {
  requiredFields: string[];
  requiredPhotos: { key: string; minCount: number }[];
  technicianLicenseRequired: boolean;
  deadlineDays: number;
  warningDays: number;
  intervalMonths: number;
  method: SubmissionMethod;
  fallback: SubmissionMethod | null;
}

/** The inspection as the compliance engine sees it, independent of how it was captured. */
export interface CanonicalInspection {
  organizationId: string;
  id: string;
  site: SiteContext;
  templateId: string;
  definition: TemplateDefinition;
  values: InspectionValues;
  photoCounts: Record<string, number>;
  technicianLicense: string | null;
  validationStatus: string;
  completedAt: Date;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

export interface Artifact {
  reportId: string;
  storageKey: string;
  filename: string;
  contentType: string;
  sha256: string;
}

export interface SubmissionPackage {
  method: SubmissionMethod;
  /** Email address or portal the package goes to. */
  destination: string | null;
  portalUrl: string | null;
  subject: string;
  body: string;
  artifacts: Artifact[];
  idempotencyKey: string;
}

export interface SubmissionResult {
  method: SubmissionMethod;
  /** Evidence the authority was sent it: the email Message-ID. */
  reference: string;
  acceptedAt: string;
  response: Record<string, unknown>;
}

export interface VerificationResult {
  confirmed: boolean;
  reference: string | null;
}

export interface JurisdictionAdapter {
  key: string;
  /** Version of the adapter code (the submission method version each filing records). */
  version: string;
  resolveRequirements(ctx: SiteContext): Promise<Requirements>;
  validate(inspection: CanonicalInspection): Promise<ValidationResult>;
  render(inspection: CanonicalInspection): Promise<Artifact[]>;
  buildSubmission(inspection: CanonicalInspection, artifacts: Artifact[], opts: { filingId: string; submissionNo: number }): Promise<SubmissionPackage>;
  submit?(pkg: SubmissionPackage, organizationId: string): Promise<SubmissionResult>;
  verify?(submission: SubmissionResult): Promise<VerificationResult>;
}

export interface AdapterDeps {
  db: Database;
  store: ObjectStore;
  mail: EmailTransport;
  /** The provider's From address for filings. */
  from?: string;
}

/**
 * Email submission with a manual portal/export fallback, driven entirely by the
 * ruleset. It renders nothing itself: the stored submission package (cover sheet and the
 * authority copy or signed contract) is what it sends. There is no automatic
 * verification; the office records the authority's acknowledgment when one arrives.
 * v2 sends the stored package; v1 sent the authority report alone.
 */
export const EMAIL_MANUAL_VERSION = "email-manual@2";

export class EmailManualAdapter implements JurisdictionAdapter {
  readonly version = EMAIL_MANUAL_VERSION;
  readonly key: string;
  private readonly rules: RulesetRules;

  constructor(
    private readonly resolved: ResolvedJurisdiction,
    private readonly deps: AdapterDeps,
  ) {
    this.key = resolved.key;
    this.rules = resolved.rules;
  }

  async resolveRequirements(): Promise<Requirements> {
    const r = this.rules;
    return {
      requiredFields: r.inspection.requiredFields,
      requiredPhotos: r.inspection.requiredPhotos,
      technicianLicenseRequired: r.inspection.technicianLicenseRequired,
      deadlineDays: r.filing.deadlineDays,
      warningDays: r.filing.warningDays,
      intervalMonths: r.service.intervalMonths,
      method: r.submission.method,
      fallback: r.submission.fallback,
    };
  }

  async validate(insp: CanonicalInspection): Promise<ValidationResult> {
    const req = requirementsOf(this.resolved, insp.site.customerType);
    const def = applyRequirements(insp.definition, req);
    const problems = validateInspection(def, insp.values, insp.photoCounts).map((p) => p.message);
    // A form made before the authority's requirement (or a company's own form) may not ask at all.
    const asked = new Set(insp.definition.fields.map((f) => f.key));
    const unasked = req.requiredFields.filter((k) => !asked.has(k));
    if (unasked.length) problems.push(`${this.resolved.authorityName} requires ${unasked.map(fieldName).join(", ")}, which this inspection's form does not ask for`);
    if (this.rules.inspection.technicianLicenseRequired && !insp.technicianLicense) problems.push("The technician's license number is missing");
    if (this.rules.submission.method === "email" && !this.rules.submission.email) problems.push("The ruleset has no email destination");
    return { ok: problems.length === 0, problems };
  }

  async render(insp: CanonicalInspection): Promise<Artifact[]> {
    const report = await this.deps.db
      .selectFrom("reports")
      .select(["id", "storageKey", "contentType", "sha256"])
      .where("organizationId", "=", insp.organizationId)
      .where("inspectionId", "=", insp.id)
      .where("audience", "=", "authority")
      .orderBy("version", "desc")
      .executeTakeFirst();
    if (!report) return [];
    const permit = insp.site.permitNumber ? `-${insp.site.permitNumber.replace(/[^a-zA-Z0-9-]/g, "")}` : "";
    return [{ reportId: report.id, storageKey: report.storageKey, filename: `inspection${permit}-${insp.id.slice(0, 8)}.pdf`, contentType: report.contentType, sha256: report.sha256 }];
  }

  async buildSubmission(insp: CanonicalInspection, artifacts: Artifact[], opts: { filingId: string; submissionNo: number }): Promise<SubmissionPackage> {
    const s = this.rules.submission;
    const permit = insp.site.permitNumber ?? "not recorded";
    const subject = (s.email?.subject ?? "Aerobic maintenance report, permit {permitNumber}").replaceAll("{permitNumber}", permit);
    const body = [
      `Attached is the aerobic system maintenance report for permit ${permit}.`,
      `Inspection completed ${insp.completedAt.toISOString().slice(0, 10)}.`,
      "",
      "Please reply with your confirmation or reference number.",
    ].join("\n");
    return {
      method: s.method,
      destination: s.email?.to ?? null,
      portalUrl: s.portalUrl,
      subject,
      body,
      artifacts,
      idempotencyKey: `filing-${opts.filingId}-submission-${opts.submissionNo}`,
    };
  }

  async submit(pkg: SubmissionPackage, organizationId: string): Promise<SubmissionResult> {
    if (pkg.method !== "email" || !pkg.destination) throw new Error("This filing is submitted by hand");
    const attachments = [];
    for (const a of pkg.artifacts) {
      const content = await this.deps.store.get(a.storageKey);
      if (!content) throw new Error(`report file ${a.reportId} is missing from storage`);
      attachments.push({ filename: a.filename, contentType: a.contentType, content });
    }
    const sent = await this.deps.mail.send({
      organizationId,
      idempotencyKey: pkg.idempotencyKey,
      from: this.deps.from ?? "filings@aerowise.invalid",
      to: pkg.destination,
      subject: pkg.subject,
      text: pkg.body,
      attachments,
    });
    return { method: "email", reference: sent.messageId, acceptedAt: sent.acceptedAt, response: sent.response };
  }
}

/**
 * Every authority files through the ruleset-driven email/manual adapter for now: what
 * differs between authorities (recipient, cover sheet, identifiers, deadlines) is data in
 * the ruleset. An authority needing something else (a portal API) gets its own adapter.
 */
export const adapterVersion = (_key: string) => EMAIL_MANUAL_VERSION;

export function adapterFor(resolved: ResolvedJurisdiction, deps: AdapterDeps): JurisdictionAdapter | null {
  return new EmailManualAdapter(resolved, deps);
}
