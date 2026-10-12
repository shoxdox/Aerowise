import Link from "next/link";
import { DATA_HANDLING } from "@/components/marketing/copy";

// The public data-handling statement: what the software does with a company's records, and who to ask.
export default function DataHandlingPage() {
  return (
    <div className="marketing">
      <header className="topbar">
        <Link href="/">
          <strong>Aerowise</strong>
        </Link>
        <span className="spacer" />
        <Link href="/login">Sign in</Link>
      </header>
      <main className="page stack">
        <h1>{DATA_HANDLING.title}</h1>
        {DATA_HANDLING.sections.map((s) => (
          <section key={s.title} className="stack" aria-labelledby={s.id}>
            <h2 id={s.id}>{s.title}</h2>
            <p>{s.body}</p>
          </section>
        ))}
      </main>
    </div>
  );
}
