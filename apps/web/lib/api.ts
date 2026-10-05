"use client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API through the same-origin /api proxy. Sends to the matching sign-in page on 401. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Sign-in forms and invitation links show a wrong password themselves.
    const showsOwn401 = path.endsWith("/auth/login") || path.startsWith("/invitations/accept/");
    if (res.status === 401 && !showsOwn401 && typeof window !== "undefined") {
      // The platform-admin console has its own sign-in, separate from the office one.
      const login = path.startsWith("/admin/") ? "/admin/login" : "/login";
      window.location.href = `${login}?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
  }
  return data as T;
}

/** Collects non-empty form fields; empty strings become undefined so optional fields stay unset. */
export function formValues(form: HTMLFormElement): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of new FormData(form).entries()) {
    const text = String(value).trim();
    out[key] = text === "" ? undefined : text;
  }
  return out;
}
