"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A button that sends something: disabled and saying so while it is on its way, so a second
 * click cannot send it twice. A form's submit button unless `type` says otherwise.
 */
export function SubmitButton({
  busy,
  busyLabel = "Saving…",
  children,
  disabled,
  type = "submit",
  ...rest
}: { busy: boolean; busyLabel?: ReactNode; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} disabled={busy || disabled} aria-busy={busy || undefined} {...rest}>
      {busy ? busyLabel : children}
    </button>
  );
}

/** A refusal or failure from a form, read out when it appears. */
export function FormError({ error, className }: { error: string | null | undefined; className?: string }) {
  if (!error) return null;
  return (
    <p className={className ? `error ${className}` : "error"} role="alert">
      {error}
    </p>
  );
}
