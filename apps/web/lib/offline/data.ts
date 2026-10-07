"use client";

import type { InspectionTemplate, Stop } from "@aerowise/domain";
import type { Me } from "../session";
import { activeStore, type CachedRoute, type Gps, type Tenant, type TenantStore } from "./db";
import { tenantHeader } from "./sync";

export type Fetched<T> = { ok: true; data: T } | { ok: false; reason: "offline" | "signed_out" | "other_account" | "error" };

/** `tenant`: the sign-in the answer is for; the server refuses it if the session is now someone else's. */
async function fetchJson<T>(path: string, tenant?: Tenant): Promise<Fetched<T>> {
  try {
    const res = await fetch(`/api${path}`, { credentials: "same-origin", cache: "no-store", headers: tenant ? tenantHeader(tenant) : undefined });
    if (res.status === 401) return { ok: false, reason: "signed_out" };
    if (res.status === 409 && ((await res.json().catch(() => ({}))) as { error?: string }).error === "tenant_mismatch") return { ok: false, reason: "other_account" };
    if (!res.ok) return { ok: false, reason: "error" };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

/** Who this phone's session is signed in as right now, straight from the server. */
export const fetchMe = () => fetchJson<Me>("/auth/me");

/**
 * Whether a company's access has definitely ended (a demo past its end): true, false when
 * the server knows nothing that says so (an expired session, say), null when it could not
 * be asked. Only true ever justifies removing that company's data from the phone.
 */
export async function accessEnded(organizationId: string): Promise<boolean | null> {
  try {
    const res = await fetch("/api/auth/access-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
      credentials: "same-origin",
      cache: "no-store",
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
  const r = await freshOrCached<{ date: string; items: Stop[] }>(store, "/route", "route");
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

export function currentPosition(timeoutMs = 8000): Promise<Gps | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.min(p.coords.accuracy, 100000) });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** Shrinks a camera photo to at most 2000px as JPEG; keeps the original if the browser cannot decode it. */
export async function preparePhoto(file: File): Promise<{ blob: Blob; contentType: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (blob) return { blob, contentType: "image/jpeg" };
  } catch {
    // Fall through to the original file.
  }
  if (!UPLOAD_TYPES.includes(file.type)) throw new Error("This photo format is not supported. Take the photo with the camera instead.");
  return { blob: file, contentType: file.type };
}
