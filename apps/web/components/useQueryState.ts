"use client";

import { useCallback, useEffect, useState } from "react";

/** Native history preserves shareable filters and back/forward without a server navigation. */
export function useQueryState(key: string, fallback: string) {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    const read = () => setValue(new URLSearchParams(window.location.search).get(key) ?? fallback);
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("aerowise-query", read);
    return () => { window.removeEventListener("popstate", read); window.removeEventListener("aerowise-query", read); };
  }, [key, fallback]);
  const choose = useCallback((next: string) => {
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(key); else url.searchParams.set(key, next);
    if (key !== "offset") url.searchParams.delete("offset");
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new Event("aerowise-query"));
    setValue(next);
  }, [key, fallback]);
  return [value, choose] as const;
}
