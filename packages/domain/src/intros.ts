// The first-run intros (W10.4): a short explanation of how the work flows, shown the first
// time someone opens the office screens or the technician app, until they close it.

export const INTROS = ["office", "technician"] as const;
export type Intro = (typeof INTROS)[number];
