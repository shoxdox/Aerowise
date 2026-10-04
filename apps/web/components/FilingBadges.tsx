import type { DeadlineState, FilingStatus } from "@aerowise/domain";
import { day } from "@/lib/format";

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  pending: "Waiting for report",
  ready: "Ready to file",
  queued: "Sending",
  submitting: "Sending",
  sent: "Sent, not confirmed",
  confirmed: "Confirmed",
  failed: "Sending failed",
  rejected: "Rejected",
  needs_review: "Needs review",
};

const STATUS_CLASS: Partial<Record<FilingStatus, string>> = {
  confirmed: "ok",
  sent: "upcoming",
  failed: "danger",
  rejected: "danger",
  needs_review: "warn",
};

export function FilingStatusBadge({ status }: { status: FilingStatus }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ""}`}>{FILING_STATUS_LABELS[status]}</span>;
}

export function DeadlineCell({ deadlineOn, state }: { deadlineOn: string | null; state: DeadlineState }) {
  if (!deadlineOn) return <span className="muted">—</span>;
  return (
    <>
      {day(deadlineOn)}
      {state === "approaching" && <span className="badge warn"> due soon</span>}
      {state === "overdue" && <span className="badge danger">overdue</span>}
    </>
  );
}
