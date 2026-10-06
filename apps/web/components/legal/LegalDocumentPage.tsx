import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENT_TITLES, type LegalDocument } from "@aerowise/domain";
import Link from "next/link";
import { LEGAL_TEXT, PLACEHOLDER_WARNING } from "./text";

/** A public terms or privacy page, with the version an owner accepts. */
export function LegalDocumentPage({ document }: { document: LegalDocument }) {
  return (
    <div className="marketing">
      <header className="topbar">
        <Link href="/">
          <strong>Aerowise</strong>
        </Link>
        <span className="spacer" />
        <Link href="/login">Sign in</Link>
      </header>
      <main className="page stack legal">
        <h1>{LEGAL_DOCUMENT_TITLES[document]}</h1>
        <p className="muted small">Version {CURRENT_LEGAL_VERSIONS[document]}</p>
        <p className="banner warn" role="note">
          {PLACEHOLDER_WARNING}
        </p>
        {LEGAL_TEXT[document].map((s) => (
          <section key={s.heading} className="stack">
            <h2>{s.heading}</h2>
            {s.paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
