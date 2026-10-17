import type { DeadlineState, FilingStatus, Tone, VerificationBadge } from "@aerowise/domain";
import { Badge } from "@/components/StatusBadge";
import { day } from "@/lib/format";

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  pending: "Waiting for report",
  ready: "Ready to file",
  queued: "Sending",
  submitting: "Sending",
  sent: "Submitted",
  confirmed: "Acknowledgment recorded",
  failed: "Sending failed",
  rejected: "Rejected",
  needs_review: "Needs review",
};

const STATUS_TONE: Partial<Record<FilingStatus, Tone>> = {
  confirmed: "success",
  sent: "info",
  failed: "danger",
  rejected: "danger",
  needs_review: "warning",
};

export function FilingStatusBadge({ status }: { status: FilingStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{FILING_STATUS_LABELS[status]}</Badge>;
}

export function DeadlineCell({ deadlineOn, state }: { deadlineOn: string | null; state: DeadlineState }) {
  if (!deadlineOn) return <span className="muted">—</span>;
  return (
    <>
      {day(deadlineOn)} {state === "approaching" && <Badge tone="warning">Due soon</Badge>}
      {state === "overdue" && <Badge tone="danger">Overdue</Badge>}
    </>
  );
}

const VERIFIED_BY: Record<VerificationBadge["method"], string> = { email: "by email", phone: "by phone", meeting: "in a meeting", letter: "by letter" };

/** Shown only for a ruleset version someone confirmed with the authority. */
export function VerifiedBadge({ verified }: { verified: VerificationBadge }) {
  return (
    <Badge tone="success" title={`Confirmed with ${verified.confirmedWith} ${VERIFIED_BY[verified.method]}`}>
      Verified with {verified.authorityName} on {day(verified.confirmedOn)}
    </Badge>
  );
}
