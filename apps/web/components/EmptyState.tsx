import type { ReactNode } from "react";

/** What an empty list is for, and what to do to fill it (W10.4). */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card empty-state" role="status">
      <strong>{title}</strong>
      <p className="muted">{children}</p>
    </div>
  );
}
