"use client";

import { useState, type InputHTMLAttributes } from "react";

/**
 * A labelled password field with a Show/Hide button, so a long password typed on a phone (often
 * with work gloves just off) can be checked before signing in. The button's name stays "Show" or
 * "Hide" rather than "Show password", so "Password" still names exactly one control on the page.
 */
export function PasswordInput({ label = "Password", ...input }: { label?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <label>
        {label}
        <input {...input} type={shown ? "text" : "password"} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <button type="button" className="reveal" aria-pressed={shown} onClick={() => setShown(!shown)}>
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}
