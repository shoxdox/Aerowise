"use client";

import type { InspectionTemplate, Stop } from "@aerowise/domain";
import type { Me } from "../session";
import { kvGet, kvSet, type CachedRoute, type Gps } from "./db";

type Fetched<T> = { ok: true; data: T } | { ok: false; reason: "offline" | "signed_out" | "error" };

async function fetchJson<T>(path: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(`/api${path}`, { credentials: "same-origin", cache: "no-store" });
    if (res.status === 401) return { ok: false, reason: "signed_out" };
    if (!res.ok) return { ok: false, reason: "error" };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

/** Fresh from the server when there is signal, otherwise the copy saved on the phone. */
async function freshOrCached<T>(path: string, key: string): Promise<{ data: T | undefined; fresh: boolean; signedOut: boolean }> {
  const res = await fetchJson<T>(path);
  if (res.ok) {
    await kvSet(key, res.data);
    return { data: res.data, fresh: true, signedOut: false };
  }
  return { data: await kvGet<T>(key), fresh: false, signedOut: res.reason === "signed_out" };
}

export const loadMe = () => freshOrCached<Me>("/auth/me", "me");

export async function loadRoute() {
  const r = await freshOrCached<{ date: string; items: Stop[] }>("/route", "route");
  if (r.fresh && r.data) await kvSet("routeFetchedAt", new Date().toISOString());
  return { route: r.data as CachedRoute | undefined, fresh: r.fresh, fetchedAt: await kvGet<string>("routeFetchedAt") };
}

export async function loadActiveTemplate(): Promise<InspectionTemplate | undefined> {
  const r = await freshOrCached<InspectionTemplate>("/inspection-template", "template:active");
  if (r.data) await kvSet(`template:${r.data.id}`, r.data);
  return r.data;
}

/** The exact template version an inspection was started with. */
export async function templateById(id: string): Promise<InspectionTemplate | undefined> {
  const cached = await kvGet<InspectionTemplate>(`template:${id}`);
  if (cached) return cached;
  const res = await fetchJson<InspectionTemplate>(`/inspection-templates/${id}`);
  if (!res.ok) return undefined;
  await kvSet(`template:${id}`, res.data);
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
