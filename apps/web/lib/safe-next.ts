/**
 * Where a sign-in page may send someone afterwards: the `?next=` path when it stays on this
 * site (and, with `within`, inside that part of it), otherwise null. It is parsed as a URL
 * against this origin rather than checked by its first characters, because browsers read
 * "/\example.org" and "//example.org" as other sites, which made the sign-in link a way to
 * hand someone's freshly signed-in browser to a lookalike page.
 */
export function safeNext(next: string | null | undefined, within = "/"): string | null {
  if (!next || typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const inside = within === "/" || url.pathname === within || url.pathname.startsWith(`${within}/`);
  return inside ? url.pathname + url.search + url.hash : null;
}

/** The `?next=` of the current address, made safe as above. */
export function nextFromAddress(within = "/"): string | null {
  if (typeof window === "undefined") return null;
  return safeNext(new URLSearchParams(window.location.search).get("next"), within);
}
