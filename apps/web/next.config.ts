import type { NextConfig } from "next";

// A bare host:port (what a host's private network hands out) means plain HTTP inside that network.
const rawApiUrl = process.env.API_URL ?? "http://localhost:4000";
const apiUrl = /^https?:\/\//.test(rawApiUrl) ? rawApiUrl : `http://${rawApiUrl}`;

const config: NextConfig = {
  transpilePackages: ["@aerowise/domain"],
  // The browser only ever talks to this origin; /api/* is proxied to the API so the
  // session cookie stays first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

export default config;
