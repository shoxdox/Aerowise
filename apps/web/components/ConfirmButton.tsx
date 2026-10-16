"use client";

import { useState, type ReactNode } from "react";

/**
 * A change that is hard to undo (delete, retire, deactivate), asked about right where it is
 * instead of in a browser pop-up: the first click shows the question with the real button
 * next to a way back, and only that second button acts.
 */
export function ConfirmButton({
  children,
  question,
  confirmLabel,
  onConfirm,
  busy = false,
  disabled,
  className = "danger",
  danger = true,
}: {
  children: ReactNode;
  /** "Delete this draft?" */
  question: ReactNode;
  /** The button that does it ("Delete draft"); the first label when left out. */
  confirmLabel?: ReactNode;
  onConfirm: () => unknown;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  /** False for a change that is not destructive, only worth a second look. */
  danger?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={className} disabled={disabled || busy} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="row confirm" role="group" aria-label="Confirm">
      <span>{question}</span>
      <button
        type="button"
        className={danger ? "danger" : undefined}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={async () => {
          await onConfirm();
          setAsking(false);
        }}
      >
        {confirmLabel ?? children}
      </button>
      <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(false)}>
        Keep it
      </button>
    </span>
  );
}
