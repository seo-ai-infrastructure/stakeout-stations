import type { NextConfig } from "next";
const backend = process.env.SEARCH_BACKEND_ORIGIN;
if (
  backend &&
  (new URL(backend).protocol !== "https:" ||
    new URL(backend).origin !== backend)
)
  throw Error("SEARCH_BACKEND_ORIGIN must be an HTTPS origin");
const config: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: backend
        ? [
            {
              source: "/api/billing/:path*",
              destination: `${backend}/api/billing/:path*`,
            },
            {
              source: "/api/captures/:path*",
              destination: `${backend}/api/captures/:path*`,
            },
            {
              source: "/api/schedules",
              destination: `${backend}/api/schedules`,
            },
            { source: "/api/evidence", destination: `${backend}/api/evidence` },
          ]
        : [],
      afterFiles: [],
      fallback: [],
    };
  },
};
export default config;
