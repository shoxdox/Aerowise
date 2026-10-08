/**
 * Features that ship off and are switched on per deployment (`AEROWISE_FEATURES`, a
 * comma-separated list read by the API, the worker and, through /app-info, the web app).
 *
 * A feature that is off hides its create screens, refuses its create routes with 409
 * `feature_off` and leaves its part out of the demo story. Records made while it was on stay
 * readable and can be finished, so turning it off strands nothing. See the service
 * workflows plan, §9.1.
 */
export const FEATURES = ["work_orders"] as const;
export type Feature = (typeof FEATURES)[number];

/** Reads `AEROWISE_FEATURES`. An unknown name is an error, so a typo never silently leaves a feature off. */
export function parseFeatures(value: string | undefined): Set<Feature> {
  const names = (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const name of names) {
    if (!(FEATURES as readonly string[]).includes(name)) throw new Error(`AEROWISE_FEATURES: unknown feature "${name}"; it may list ${FEATURES.join(", ")}`);
  }
  return new Set(names as Feature[]);
}
