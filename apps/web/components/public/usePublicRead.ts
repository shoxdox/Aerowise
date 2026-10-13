"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";

/** Public links never redirect to staff sign-in. Reads are bounded and tied to their token. */
export function usePublicRead<T>(path: string) {
  const [state, setState] = useState<{ path: string; data: T | null; error: ApiError | null; loading: boolean }>({ path: "", data: null, error: null, loading: true });
  const active = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState((s) => ({ path, data: s.path === path ? s.data : null, error: null, loading: true }));
    const timer = window.setTimeout(() => controller.abort("timeout"), 15_000);
    try {
      const response = await fetch(`/api${path}`, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new ApiError(response.status, body.error ?? "error", body.message ?? "Could not load this page.");
      if (sequence.current === request) setState({ path, data: body as T, error: null, loading: false });
    } catch (err) {
      if (sequence.current !== request) return;
      const failure = err instanceof ApiError ? err : new ApiError(0, controller.signal.reason === "timeout" ? "stalled" : !navigator.onLine ? "offline" : "temporary", "Could not load this page.");
      // Access failures revoke the displayed record too. Temporary failures retain only same-link context.
      setState((s) => ({ path, data: s.path === path && (failure.status === 0 || failure.status >= 500 || failure.status === 429) ? s.data : null, error: failure, loading: false }));
    } finally {
      window.clearTimeout(timer);
    }
  }, [path]);
  useEffect(() => {
    void reload();
    return () => { ++sequence.current; active.current?.abort(); };
  }, [reload]);
  const current = state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: !current || state.loading, reload };
}

/** Poll briefly after Checkout; long bank settlement remains a pending state with manual refresh. */
export function useConfirmationPolling(active: boolean, reload: () => Promise<void>) {
  const [exhausted, setExhausted] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    setExhausted(false);
    if (!active) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      await reload();
      if (cancelled) return;
      attempts++;
      if (attempts >= 20) { setExhausted(true); return; }
      timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, reload, round]);
  const refresh = async () => { await reload(); setRound((r) => r + 1); };
  return { exhausted, refresh };
}
