import { statusLabel, type StatusDomain, type StatusValue, type Tone } from "@aerowise/domain";
import type { ReactNode } from "react";

/** The one place a tone becomes a badge style. */
const TONE_CLASS: Record<Tone, string> = {
  neutral: "badge",
  info: "badge upcoming",
  success: "badge ok",
  warning: "badge warn",
  danger: "badge danger",
  muted: "badge inactive",
  struck: "badge cancelled",
};

export const toneClass = (tone: Tone) => TONE_CLASS[tone];

/**
 * A stored status as people read it: `<StatusBadge of="job" value={v.status} />` shows
 * "In progress" in the right color, never "in_progress".
 */
export function StatusBadge<D extends StatusDomain>({ of, value, children, ...rest }: { of: D; value: StatusValue<D> | (string & {}); children?: ReactNode; title?: string; "data-testid"?: string }) {
  const { label, tone } = statusLabel(of, value);
  return (
    <span className={TONE_CLASS[tone]} {...rest}>
      {children ?? label}
    </span>
  );
}

/** A badge with its own words, in one of the shared tones. */
export function Badge({ tone = "neutral", children, ...rest }: { tone?: Tone; children: ReactNode; title?: string; "data-testid"?: string }) {
  return (
    <span className={TONE_CLASS[tone]} {...rest}>
      {children}
    </span>
  );
}
