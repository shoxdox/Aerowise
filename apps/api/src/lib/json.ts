type Jsonified<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

/** Converts top-level Date values to ISO strings so rows match the API's response schemas. */
export function jsonRow<T extends object>(row: T): Jsonified<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out as Jsonified<T>;
}

/** Drops keys whose value is `undefined`, so a PATCH only touches the fields it sends. */
export function definedOnly<T extends Record<string, unknown>>(body: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
