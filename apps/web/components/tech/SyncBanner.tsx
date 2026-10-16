import { useSyncExternalStore } from "react";
import { STORAGE_FULL_MESSAGE, useStorageFull } from "@/lib/offline/storage";
import type { SyncState } from "@/lib/offline/sync";
import { plural } from "./plural";

export function SyncBanner({
  state,
  failures,
  needsSignIn,
  onRetry,
  onRetryFailed,
}: {
  state: SyncState;
  failures: string[];
  needsSignIn: boolean;
  onRetry: () => void;
  /** Sends the turned-down changes again; they stay on the phone either way. */
  onRetryFailed?: () => void;
}) {
  const waiting = state.waiting ?? 0;
  const storageFull = useStorageFull();
  const online = useSyncExternalStore(listener => {
    window.addEventListener("online", listener); window.addEventListener("offline", listener);
    return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); };
  }, () => navigator.onLine, () => true);
  return (
    <div className="sync-area">
      {!online && <p className="sync warn" role="status" data-testid="offline-status">Offline. Saved work stays on this phone; office delivery waits for signal.</p>}
      {needsSignIn ? (
        // A send was refused under this sign-in: one line, with what waits, never next to "All changes sent".
        <p className="sync warn" role="status" data-testid="sync-status">
          {state.pending > 0
            ? `Sign in again to send ${plural(state.pending, "change")}. ${state.pending === 1 ? "It is" : "They are"} saved on this phone.`
            : "You were signed out. Sign in again to keep working."}{" "}
          <a href="/login?next=/tech">Sign in</a>
          {state.kind !== "syncing" && (
            <>
              {" · "}
              <button className="link" onClick={onRetry}>
                Try now
              </button>
            </>
          )}
        </p>
      ) : state.pending > 0 ? (
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
      ) : state.kind === "syncing" ? (
        // A pass is counting what is queued; nothing is claimed sent until it has.
        <p className="sync" role="status" data-testid="sync-status">
          Checking for changes to send…
        </p>
      ) : (
        // Not while anything waits for a later version, or was turned down (still on the phone, shown below).
        waiting === 0 &&
        state.failed === 0 && (
          <p className="sync ok" role="status" data-testid="sync-status">
            {storageFull ? "Previously saved changes sent; latest edits may still need a local save." : "All changes sent"}
          </p>
        )
      )}
      {waiting > 0 && (
        // Saved by a later version of the app, which this one cannot send: kept until it updates.
        <p className="sync warn" role="status" data-testid="update-waiting">
          {plural(waiting, "item")} will send after the app updates. {waiting === 1 ? "It is" : "They are"} saved on this phone.
        </p>
      )}
      {storageFull && (
        <p className="sync error" role="alert" data-testid="storage-full-banner">
          {STORAGE_FULL_MESSAGE} Nothing already saved has been lost.{" "}
          {state.kind !== "syncing" && (
            <button className="link" onClick={onRetry}>
              Send now
            </button>
          )}
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
          {onRetryFailed && state.kind !== "syncing" && (
            <button className="secondary" onClick={onRetryFailed} data-testid="retry-failed">
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
