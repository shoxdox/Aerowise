import { statusLabel, type RenewalStatus } from "@aerowise/domain";
import { toneClass } from "@/components/StatusBadge";

export function RenewalBadge({ status }: { status: RenewalStatus }) {
  const { label, tone } = statusLabel("renewal", status);
  return <span className={`${toneClass(tone)} renewal`}>{label}</span>;
}
