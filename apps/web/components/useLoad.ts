"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";

/** Loads an API resource and exposes a reload function for after edits. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest request may set state, so a slow answer for an earlier path (or an
  // earlier reload) never overwrites a newer one.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const request = ++latest.current;
    try {
      const result = await api<T>(path);
      if (request !== latest.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (request !== latest.current) return;
      setError(err instanceof ApiError ? err.message : "Could not load");
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}
