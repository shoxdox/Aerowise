"use client";

export function Pagination({ total, offset, pageSize = 50, onChange }: { total: number; offset: number; pageSize?: number; onChange: (offset: number) => void }) {
  return <nav className="row muted" aria-label="Result pages"><span>{total === 0 ? "Showing 0 of 0" : `Showing ${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}`}</span><span className="spacer" /><button className="secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))}>Previous</button><button className="secondary" disabled={offset + pageSize >= total} onClick={() => onChange(offset + pageSize)}>Next</button></nav>;
}
