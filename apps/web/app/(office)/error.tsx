"use client";

import Link from "next/link";
import { useEffect } from "react";

/** One screen failing keeps the menu: the office can retry it or go on to another. */
export default function OfficeError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="card stack" role="alert">
      <h1>Something went wrong on this screen</h1>
      <p className="muted">Nothing you saved is lost. Try it again, or go on to another screen.</p>
      <div className="row">
        <button onClick={() => retry()}>Try again</button>
        <Link href="/inbox">Go to Inbox</Link>
      </div>
    </div>
  );
}
