"use client";

import type { FormTemplate, Inspection, InspectionTemplate, PumpingFieldData, Stop, WorkStop } from "@aerowise/domain";
import type { Me } from "../session";
import type { LocationStatus } from "@aerowise/domain";
import { activeStore, type CachedRoute, type Gps, type Tenant, type TenantStore } from "./db";
import { tenantHeader } from "./sync";
import type { WorkStore } from "./work";

/**
 * A read that has not answered in this long is treated as no signal, and the copy saved on
 * the phone is used: a weak connection can hold a request open for a minute or more.
 */
const READ_TIMEOUT_MS = 10_000;

/** While set, reads do not try the network at all: the session check just found none. */
let offlineAssumed = false;

/**
 * Runs `fn` with every read answering "offline" at once. Used by the app's start-up after the
 * session check timed out, so the route, template and work are opened from the phone's copy
 * in one go instead of each waiting out its own timeout.
 */
export async function assumingOffline<T>(fn: () => Promise<T>): Promise<T> {
  offlineAssumed = true;
  try {
    return await fn();
  } finally {
    offlineAssumed = false;
  }
}

export type Fetched<T> = { ok: true; data: T } | { ok: false; reason: "offline" | "signed_out" | "other_account" | "error" };

/** `tenant`: the sign-in the answer is for; the server refuses it if the session is now someone else's. */
async function fetchJson<T>(path: string, tenant?: Tenant): Promise<Fetched<T>> {
  if (offlineAssumed) return { ok: false, reason: "offline" };
  try {
    const res = await fetch(`/api${path}`, { credentials: "same-origin", cache: "no-store", headers: tenant ? tenantHeader(tenant) : undefined, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (res.status === 401) return { ok: false, reason: "signed_out" };
    if (res.status === 409 && ((await res.json().catch(() => ({}))) as { error?: string }).error === "tenant_mismatch") return { ok: false, reason: "other_account" };
    if (!res.ok) return { ok: false, reason: "error" };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

/** The inspection the server holds for a job, to continue one started on another phone. */
export const fetchInspectionForJob = (jobId: string, tenant?: Tenant) => fetchJson<Inspection>(`/jobs/${jobId}/inspection`, tenant);

/** Who this phone's session is signed in as right now, straight from the server. */
export const fetchMe = () => fetchJson<Me>("/auth/me");

/**
 * Whether a company's access has definitely ended (a demo past its end, or removed): true, false when
 * the server knows nothing that says so (an expired session, say), null when it could not
 * be asked. Only true ever justifies removing that company's data from the phone.
 */
export async function accessEnded(organizationId: string, demoTicket?: string): Promise<boolean | null> {
  try {
    const res = await fetch("/api/auth/access-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, demoTicket }),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { state?: string }).state === "ended";
  } catch {
    return null;
  }
}

/** Fresh from the server when there is signal, otherwise the copy saved on the phone. */
async function freshOrCached<T>(store: TenantStore, path: string, key: string): Promise<{ data: T | undefined; fresh: boolean }> {
  const res = await fetchJson<T>(path, store.tenant);
  if (res.ok) {
    await store.kvSet(key, res.data);
    return { data: res.data, fresh: true };
  }
  return { data: await store.kvGet<T>(key), fresh: false };
}

export async function loadRoute(store: TenantStore) {
  const r = await freshOrCached<{ date: string; items: Stop[]; onTheWayTexts?: boolean }>(store, "/route", "route");
  if (r.fresh && r.data) await store.kvSet("routeFetchedAt", new Date().toISOString());
  return { route: r.data as CachedRoute | undefined, fresh: r.fresh, fetchedAt: await store.kvGet<string>("routeFetchedAt") };
}

export async function loadActiveTemplate(store: TenantStore): Promise<InspectionTemplate | undefined> {
  const r = await freshOrCached<InspectionTemplate>(store, "/inspection-template", "template:active");
  if (r.data) await store.kvSet(`template:${r.data.id}`, r.data);
  return r.data;
}

/** The exact template version an inspection was started with. */
export async function templateById(id: string): Promise<InspectionTemplate | undefined> {
  const store = activeStore();
  const cached = await store.kvGet<InspectionTemplate>(`template:${id}`);
  if (cached) return cached;
  const res = await fetchJson<InspectionTemplate>(`/inspection-templates/${id}`, store.tenant);
  if (!res.ok) return undefined;
  await store.kvSet(`template:${id}`, res.data);
  return res.data;
}

/**
 * The technician's work visits for today (SW-2), fresh when there is signal, otherwise as saved.
 * Saved only once there is work to save, so a phone with no work visits never gets a work database.
 */
export async function loadWorkRoute(store: WorkStore): Promise<{ date: string; items: WorkStop[] } | undefined> {
  const res = await fetchJson<{ date: string; items: WorkStop[] }>("/work/route", store.tenant);
  if (!res.ok) return store.kvGet("route");
  if (res.data.items.length > 0 || (await store.kvGet("route"))) {
    await store.kvSet("route", res.data);
    // The forms these visits use, kept by version id so a visit started on one keeps it.
    const forms = await fetchJson<{ items: FormTemplate[] }>("/form-templates?purpose=work", store.tenant);
    if (forms.ok) for (const f of forms.data.items) await store.kvSet(`form:${f.id}`, f);
  }
  return res.data;
}

/** SW-6: trucks, facilities and the technician's pump-outs in no load yet; the last copy when offline. */
export async function loadPumpingField(store: WorkStore, pumpingVisits: boolean): Promise<PumpingFieldData | undefined> {
  const res = await fetchJson<PumpingFieldData>("/pumping/field", store.tenant);
  if (!res.ok) return store.kvGet("pumping-field");
  // Saved only for a route with pumping visits, pump-outs to load, or a copy to replace: like the route, writing
  // would otherwise create, or upgrade, the work database on a phone that has no work in it.
  if (pumpingVisits || res.data.unloaded.length > 0 || (await store.kvGet("pumping-field"))) await store.kvSet("pumping-field", res.data);
  return res.data;
}

/** The exact work form version a visit uses, from the phone. */
export const workFormById = (store: WorkStore, id: string) => store.kvGet<FormTemplate>(`form:${id}`);

/**
 * The phone's position, and why there is none when there is none. A denied permission is
 * told to the technician and sent to the office with the visit (`locationStatus`), instead of
 * looking the same as a phone that simply had no fix.
 */
export function locate(timeoutMs = 8000): Promise<{ gps: Gps | null; status: LocationStatus }> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return Promise.resolve({ gps: null, status: "unsupported" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ gps: null, status: "timeout" }), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ gps: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.min(p.coords.accuracy, 100000) }, status: "recorded" });
      },
      (err) => {
        clearTimeout(timer);
        resolve({ gps: null, status: err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable" });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

export const currentPosition = async (timeoutMs = 8000): Promise<Gps | null> => (await locate(timeoutMs)).gps;

const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** Shrinks a camera photo to at most 2000px as JPEG; keeps the original if the browser cannot decode it. */
export async function preparePhoto(file: File): Promise<{ blob: Blob; contentType: string; preview?: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (blob) {
      const preview = document.createElement("canvas");
      const thumbScale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
      preview.width = Math.max(1, Math.round(bitmap.width * thumbScale));
      preview.height = Math.max(1, Math.round(bitmap.height * thumbScale));
      preview.getContext("2d")!.drawImage(bitmap, 0, 0, preview.width, preview.height);
      bitmap.close();
      return { blob, contentType: "image/jpeg", preview: preview.toDataURL("image/jpeg", 0.65) };
    }
    bitmap.close();
  } catch {
    // Fall through to the original file.
  }
  if (!UPLOAD_TYPES.includes(file.type)) throw new Error("This photo format is not supported. Take the photo with the camera instead.");
  return { blob: file, contentType: file.type };
}
