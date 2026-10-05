import type { NextConfig } from "next";

// A bare host:port (what a host's private network hands out) means plain HTTP inside that network.
const rawApiUrl = process.env.API_URL ?? "http://localhost:4000";
const apiUrl = /^https?:\/\//.test(rawApiUrl) ? rawApiUrl : `http://${rawApiUrl}`;

// Security headers on every page (the API sets its own on /api/*). Customer links carry
// their token in the path (/portal/…, /pay/…, /renew/…, /invite/…), so no page sends a
// Referer to another site. Pages may not be framed; the technician app may use the camera
// and location.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()" },
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const config: NextConfig = {
  transpilePackages: ["@aerowise/domain"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/((?!api/).*)", headers: securityHeaders }];
  },
  // The browser only ever talks to this origin; /api/* is proxied to the API so the
  // session cookie stays first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

export default config;
