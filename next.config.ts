import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["ws"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
