"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";

/** Results belong to their query. A changed filter never relabels the last query's rows. */
export function useLoad<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null; errorStatus: number | null; pending: boolean; updatedAt: number | null }>({ path: null, data: null, error: null, errorStatus: null, pending: false, updatedAt: null });
  const latest = useRef(0);
  const active = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    active.current?.abort();
    if (!path) return;
    const controller = new AbortController();
    active.current = controller;
    setState((s) => ({ path, data: s.path === path ? s.data : null, error: null, errorStatus: null, pending: true, updatedAt: s.path === path ? s.updatedAt : null }));
    const timeout = window.setTimeout(() => controller.abort("timeout"), 20_000);
    try {
      const data = await api<T>(path, { signal: controller.signal });
      if (request === latest.current) setState({ path, data, error: null, errorStatus: null, pending: false, updatedAt: Date.now() });
    } catch (err) {
      if (request !== latest.current) return;
      const error = controller.signal.aborted ? "This request took too long. Check your connection and retry." : err instanceof ApiError ? err.message : "Could not load. Check your connection and retry.";
      setState((s) => ({ ...s, path, error, errorStatus: err instanceof ApiError ? err.status : null, pending: false }));
    } finally {
      window.clearTimeout(timeout);
    }
  }, [path]);
  useEffect(() => {
    void reload();
    return () => { ++latest.current; active.current?.abort(); };
  }, [reload]);
  const current = state.path === path;
  const data = current ? state.data : null;
  return { data, error: current ? state.error : null, errorStatus: current ? state.errorStatus : null, reload, loading: Boolean(path) && (!current || (state.pending && !data)), refreshing: current && state.pending && Boolean(data), stale: current && Boolean(state.error && data), updatedAt: current ? state.updatedAt : null };
}
