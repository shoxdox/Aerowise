/**
 * The phone's clock is not trusted beyond reason. A stamp from the future (past a small
 * allowance for skew) or from more than a month ago is moved to the server's time, and
 * an arrival after the completion is moved back to it: compliance deadlines, next due dates
 * and late fees are counted from these stamps, so a phone a year out must not set them.
 */
export const PHONE_CLOCK_AHEAD_MS = 15 * 60_000;
export const PHONE_CLOCK_BEHIND_MS = 30 * 24 * 3600_000;

export interface PhoneTimes {
  arrivedAt: string;
  completedAt: string | null;
  /** What was changed and from what, for the audit log; empty when the phone's clock was fine. */
  adjusted: { field: "arrivedAt" | "completedAt"; from: string; to: string }[];
}

export function boundPhoneTimes(input: { arrivedAt: string; completedAt?: string | null }, at: Date): PhoneTimes {
  const adjusted: PhoneTimes["adjusted"] = [];
  const bound = (field: "arrivedAt" | "completedAt", value: string) => {
    const t = new Date(value).getTime();
    if (t > at.getTime() + PHONE_CLOCK_AHEAD_MS || t < at.getTime() - PHONE_CLOCK_BEHIND_MS) {
      adjusted.push({ field, from: value, to: at.toISOString() });
      return at.toISOString();
    }
    return value;
  };
  let arrivedAt = bound("arrivedAt", input.arrivedAt);
  const completedAt = input.completedAt ? bound("completedAt", input.completedAt) : null;
  if (completedAt && new Date(arrivedAt).getTime() > new Date(completedAt).getTime()) {
    adjusted.push({ field: "arrivedAt", from: arrivedAt, to: completedAt });
    arrivedAt = completedAt;
  }
  return { arrivedAt, completedAt, adjusted };
}
