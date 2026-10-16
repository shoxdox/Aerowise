import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found · Aerowise" };

/** Any address Aerowise does not have: said plainly, with a way back in. */
export default function NotFound() {
  return (
    <main className="pad stack" style={{ maxWidth: 520, margin: "64px auto" }}>
      <Link href="/" className="row" aria-label="Aerowise home" style={{ textDecoration: "none", color: "inherit" }}>
        <img src="/icons/icon.svg" alt="" width={32} height={32} />
        <strong>Aerowise</strong>
      </Link>
      <h1>Page not found</h1>
      <p className="muted">This address isn&apos;t one of ours, or the link is out of date.</p>
      <div className="row">
        <Link className="button" href="/inbox">
          Go to the office
        </Link>
        <Link href="/">Aerowise home</Link>
      </div>
    </main>
  );
}
