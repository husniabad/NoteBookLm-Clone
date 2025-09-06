import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    // Exclude problematic dependencies from the server build
    if (isServer) {
      config.externals.push('canvas', 'log4js');
    }
    return config;
  },
};

export default nextConfig;
