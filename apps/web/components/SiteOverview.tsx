"use client";

import type { SiteDetail } from "@aerowise/domain";
import Link from "next/link";
import { LoadState } from "@/components/LoadState";
import { useLoad } from "@/components/useLoad";
import { day, when } from "@/lib/format";

interface Overview {
  contract: { planName: string; startOn: string; endOn: string } | null;
  obligation: { id: string; dueOn: string; serviceType: string } | null;
  visit: { scheduledDate: string; name: string } | null;
  report: { generatedAt: string; signedAt: string | null; filingId: string | null; filingStatus: string | null; version: number } | null;
  issues: { id: string; description: string; severity: string; workOrderId: string | null }[];
}

export function SiteOverview({ site }: { site: SiteDetail }) {
  const load = useLoad<Overview>(`/sites/${site.id}/overview`);
  const data = load.data;
  const system = site.systems.find((s) => s.active);
  return <section className="card stack" aria-labelledby="site-current"><h2 id="site-current">Current record and next action</h2><LoadState load={load} label="site overview" /><dl className="details"><dt>Current system</dt><dd>{system ? [system.manufacturer, system.model, system.systemCategory].filter(Boolean).join(" · ") || "System recorded; details incomplete" : "No active system recorded"}</dd>{data && <><dt>Current contract</dt><dd>{data.contract ? `${data.contract.planName} · ${day(data.contract.startOn)}–${day(data.contract.endOn)}` : "No current contract"} · <a href="#contracts">Review contracts</a></dd><dt>Next visit</dt><dd>{data.visit ? `${day(data.visit.scheduledDate)} · ${data.visit.name}` : data.obligation ? `Unscheduled · due ${day(data.obligation.dueOn)}` : "No open visit recorded"}{data.obligation && <> · <Link href={data.obligation.serviceType === "aerobic_inspection" ? `/schedule?obligationId=${data.obligation.id}&siteId=${site.id}` : `/sites/${site.id}?obligationId=${data.obligation.id}#obligation-${data.obligation.id}`}>Schedule / review this visit</Link></>}</dd><dt>Most recent report</dt><dd>{data.report ? <>Version {data.report.version}, {when(data.report.generatedAt)} · {data.report.signedAt ? "provider signature recorded" : "awaiting provider signature"}{data.report.filingId && <> · <Link href={`/filings/${data.report.filingId}`}>Open report, status and filing evidence</Link></>}</> : "No report yet; schedule and complete the first inspection"}</dd></>}</dl>{data && data.issues.length > 0 && <div><h3>Outstanding issues ({data.issues.length})</h3><ul>{data.issues.map((i) => <li key={i.id}><span className={i.severity === "high" ? "error" : ""}>{i.description}</span>{i.workOrderId ? <> · <Link href={`/work/${i.workOrderId}`}>Open related work</Link></> : <> · <Link href="/inbox">Resolve in Inbox</Link></>}</li>)}</ul></div>}{data && data.issues.length === 0 && <p className="muted small">No open inspection issues recorded. Authority questions and service requests remain below.</p>}</section>;
}
