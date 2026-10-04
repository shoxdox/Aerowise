import { RENEWAL_STATUS_LABELS, type RenewalStatus } from "@aerowise/domain";

const CLASS: Record<RenewalStatus, string> = {
  upcoming: "",
  sent: "upcoming",
  viewed: "upcoming",
  signed: "warn",
  payment_pending: "warn",
  paid: "warn",
  activated: "completed",
  declined: "inactive",
  expired: "inactive",
  needs_review: "danger",
};

export function RenewalBadge({ status }: { status: RenewalStatus }) {
  return <span className={`badge renewal ${CLASS[status]}`}>{RENEWAL_STATUS_LABELS[status]}</span>;
}
