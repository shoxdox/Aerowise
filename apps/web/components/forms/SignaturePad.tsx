"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

// The one signature pad for every page that asks for a drawn signature: the homeowner's renewal
// page today, the technician's phone and the estimate page later.

/** A finger or mouse signature, kept as a PNG. */
export function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = c.clientWidth;
    c.height = c.clientHeight;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1c2321";
    }
  }, []);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top] as const;
  };
  function down(e: PointerEvent<HTMLCanvasElement>) {
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const [x, y] = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const [x, y] = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  function up() {
    if (!drawing.current || !canvas.current) return;
    drawing.current = false;
    setEmpty(false);
    onChange(canvas.current.toDataURL("image/png"));
  }
  function clear() {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    onChange(null);
  }

  return (
    <div className="stack">
      <canvas ref={canvas} className="signature-pad" aria-label="Signature pad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      <div className="row">
        <span className="muted small">{empty ? "Sign above with your finger or mouse." : "Signed."}</span>
        <span className="spacer" />
        <button type="button" className="link" onClick={clear}>
          Clear
        </button>
      </div>
    </div>
  );
}
