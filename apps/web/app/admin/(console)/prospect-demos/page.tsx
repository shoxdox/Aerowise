"use client";

import { useState, type FormEvent } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { when } from "@/lib/format";

interface ProspectDemo {
  id: string;
  prospect: string;
  name: string;
  serviceCounties: string[];
  createdAt: string;
  endsAt: string;
  state: "live" | "ended";
  activeLinks: number;
}

/**
 * Personalized prospect demos (W10.6): a fictional demo company under a prospect's name and
 * counties, with a sign-in link you copy and send yourself. Aerowise sends nothing.
 */
export default function ProspectDemosPage() {
  const demos = useLoad<{ items: ProspectDemo[] }>("/admin/prospect-demos");
  const { data, reload } = demos;
  const [prospect, setProspect] = useState("");
  const [counties, setCounties] = useState("");
  const [days, setDays] = useState(14);
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [converted, setConverted] = useState<string | null>(null);

  // One change at a time: a second click while one is on its way does nothing.
  const acting = useSubmit(
    async (fn: () => Promise<unknown>) => {
      const out = await fn();
      await reload();
      return out;
    },
    { fallback: "Something went wrong. Try again." },
  );
  const act = async <T,>(fn: () => Promise<T>) => (await acting.run(fn)) as T | undefined;
  const busy = acting.busy;

  async function create(e: FormEvent) {
    e.preventDefault();
    const serviceCounties = counties.split(",").map((c) => c.trim()).filter(Boolean);
    const out = await act(() => api<{ demo: ProspectDemo; link: { url: string } }>("/admin/prospect-demos", { method: "POST", body: { prospect, serviceCounties, days } }));
    if (out) {
      setLink({ id: out.demo.id, url: out.link.url });
      setProspect("");
      setCounties("");
    }
  }

  return (
    <div className="stack">
      <h1>Prospect demos</h1>
      <p className="muted">
        A demo company with fictional customers and work, under the prospect&apos;s name and counties. Its sites stay in the fictional Example County, so nothing in it says how a real county
        handles reports. Copy the link and send it yourself: nothing is emailed or texted from here.
      </p>
      <form className="card stack" onSubmit={create}>
        <label>
          Prospect&apos;s company
          <input required value={prospect} onChange={(e) => setProspect(e.target.value)} />
        </label>
        <label>
          Counties they work in (comma-separated)
          <input required value={counties} onChange={(e) => setCounties(e.target.value)} placeholder="Travis County, Hays County" />
        </label>
        <label>
          Days until it ends
          <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <div className="row">
          <SubmitButton busy={busy} busyLabel="Working…">
            Make the demo
          </SubmitButton>
        </div>
      </form>
      <LoadState load={demos} label="prospect demos" quiet />
      <FormError error={acting.error} />
      {link && (
        <p className="card" role="status">
          Sign-in link (shown once; it works until the demo ends): <code data-testid="prospect-demo-link">{link.url}</code>
        </p>
      )}
      {converted && (
        <p className="card" role="status">
          Trial company made. Invite its owner from <a href="/admin">Organizations</a>.
        </p>
      )}
      {data && data.items.length === 0 && <p className="muted">No prospect demos yet.</p>}
      {data?.items.map((d) => (
        <article key={d.id} className={`card stack${d.state === "ended" ? " muted" : ""}`} aria-label={`Demo for ${d.prospect}`}>
          <div className="row">
            <strong>{d.prospect}</strong>
            {d.state === "live" ? <Badge tone="success">Live</Badge> : <Badge tone="muted">Ended</Badge>}
            <span className="spacer" />
            <span className="muted small">
              Made {when(d.createdAt)}, {d.state === "live" ? "ends" : "ended"} {when(d.endsAt)}
            </span>
          </div>
          <p className="small">Counties: {d.serviceCounties.join(", ")}</p>
          {d.state === "live" && (
            <div className="row">
              <button
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  const out = await act(() => api<{ url: string }>(`/admin/prospect-demos/${d.id}/links`, { method: "POST", body: {} }));
                  if (out) setLink({ id: d.id, url: out.url });
                }}
              >
                New link (revokes the old one)
              </button>
              <ConfirmButton
                className="secondary"
                danger={false}
                question={`Start a real trial company for ${d.prospect}? The demo ends and nothing from it is kept.`}
                confirmLabel="Start their trial"
                busy={busy}
                onConfirm={async () => {
                  const out = await act(() => api<{ organizationId: string }>(`/admin/prospect-demos/${d.id}/convert`, { method: "POST", body: {} }));
                  if (out) setConverted(out.organizationId);
                }}
              >
                Start their trial
              </ConfirmButton>
              <ConfirmButton
                className="link danger"
                question={`End the demo for ${d.prospect} now? Its link stops working and its data is emptied.`}
                confirmLabel="End now"
                busy={busy}
                onConfirm={() => act(() => api(`/admin/prospect-demos/${d.id}/end`, { method: "POST", body: {} }))}
              >
                End now
              </ConfirmButton>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
