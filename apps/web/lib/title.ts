"use client";

import { useEffect } from "react";

/**
 * Names the browser tab after what is open ("Carlos Calloway · Aerowise"), so a customer, an
 * invoice and the schedule open side by side can be told apart. Client pages cannot export
 * metadata, so this sets document.title. Null leaves the title as it is (the record is loading).
 */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `${title} · Aerowise`;
    return () => {
      document.title = before;
    };
  }, [title]);
}
