import Link from "next/link";
import { DATA_HANDLING } from "@/components/marketing/copy";

// The public data-handling statement. The wording is a placeholder until Justin supplies it.
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
        <p className="notice">{DATA_HANDLING.draftNote}</p>
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
