"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { ApiError, formValues, issueMessages, messageFor } from "@/lib/api";

interface Options {
  /** What to say when the server cannot be reached ("Could not save the draft."). */
  fallback?: string;
  /** Names for fields the API may refuse, by last key or full path (`{ billingPostalCode: "ZIP" }`). */
  labels?: Record<string, string>;
  /**
   * The change ends by leaving this screen (it opens what it made). After it succeeds the button
   * stays busy, so a click while the next screen loads cannot make a second one.
   */
  leaves?: boolean;
}

/**
 * One way to send a change: a second click while the first is on its way does nothing (a ref,
 * so even two clicks in the same frame send once), the button can say it is busy, and a refusal
 * becomes words the person can act on, with the fields a validation error named.
 *
 *   const save = useSubmit(async (v) => api(...), { fallback: "Could not save the contact." });
 *   <form onSubmit={save.form}> … <SubmitButton busy={save.busy}>Save</SubmitButton> {save.error}
 */
export function useSubmit<A extends unknown[], R>(fn: (...args: A) => Promise<R>, options: Options = {}) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const latest = useRef(fn);
  latest.current = fn;
  const opts = useRef(options);
  opts.current = options;

  /** Runs the change once at a time. Resolves to its result, or undefined when it failed or was already running. */
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    let left = false;
    try {
      const result = await latest.current(...args);
      left = Boolean(opts.current.leaves);
      return result;
    } catch (err) {
      setError(messageFor(err, opts.current.fallback, opts.current.labels));
      if (err instanceof ApiError) setFieldErrors(issueMessages(err.issues, opts.current.labels));
      return undefined;
    } finally {
      if (!left) {
        running.current = false;
        setBusy(false);
      }
    }
  }, []);

  /** A form's onSubmit: stops the page reload and passes the form's values (and the form) to the change. */
  const form = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      void run(...([formValues(target), target] as unknown as A));
    },
    [run],
  );

  /** The message for one field, by its API path ("/customer/billingPostalCode"), for aria-invalid and a hint. */
  const fieldError = (path: string) => fieldErrors[path] ?? null;
  const clear = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  return { run, form, busy, error, setError, fieldErrors, fieldError, clear };
}

export type Submit = ReturnType<typeof useSubmit>;
