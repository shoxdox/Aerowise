"use client";

/** Where these rows sit in the whole list. The paging buttons show only when there is more than one page; an empty list says nothing here. */
export function Pagination({ total, offset, pageSize = 50, onChange }: { total: number; offset: number; pageSize?: number; onChange: (offset: number) => void }) {
  if (total === 0) return null;
  const pages = total > pageSize || offset > 0;
  return (
    <nav className="row muted" aria-label="Result pages">
      <span>{`Showing ${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}`}</span>
      {pages && (
        <>
          <span className="spacer" />
          <button className="secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))}>
            Previous
          </button>
          <button className="secondary" disabled={offset + pageSize >= total} onClick={() => onChange(offset + pageSize)}>
            Next
          </button>
        </>
      )}
    </nav>
  );
}
