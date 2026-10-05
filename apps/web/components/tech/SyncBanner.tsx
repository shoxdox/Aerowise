import type { SyncState } from "@/lib/offline/sync";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function SyncBanner({ state, failures, needsSignIn, onRetry }: { state: SyncState; failures: string[]; needsSignIn: boolean; onRetry: () => void }) {
  return (
    <div className="sync-area">
      {needsSignIn && (
        <p className="sync warn" role="status">
          Sign in again to send your changes. They are saved on this phone.{" "}
          <a href="/login?next=/tech">Sign in</a>
        </p>
      )}
      {state.pending > 0 ? (
        <p className={`sync ${state.kind === "offline" || state.kind === "read_only" ? "warn" : ""}`} role="status" data-testid="sync-status">
          {state.kind === "offline"
            ? `No signal. ${plural(state.pending, "change")} saved on this phone, will send when you're back online.`
            : state.kind === "read_only"
              ? `Your company's account is read-only. ${plural(state.pending, "change")} saved on this phone, will send once it is reactivated.`
            : state.kind === "syncing"
              ? `Sending ${plural(state.pending, "change")}…`
              : `${plural(state.pending, "change")} waiting to send.`}{" "}
          {state.kind !== "syncing" && (
            <button className="link" onClick={onRetry}>
              Try now
            </button>
          )}
        </p>
      ) : (
        <p className="sync ok" role="status" data-testid="sync-status">
          All changes sent
        </p>
      )}
      {failures.length > 0 && (
        <div className="sync error" role="alert">
          <strong>{plural(failures.length, "change")} the office needs to look at:</strong>
          <ul>
            {[...new Set(failures)].map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
