import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    // Exclude problematic dependencies from the server build
    if (isServer) {
      config.externals.push('canvas', 'log4js');
    }
    return config;
  },
  serverExternalPackages: ['sharp', 'pdf2pic'],
  // Increase body size limit for PDF uploads
  serverRuntimeConfig: {
    maxFileSize: '50mb'
  },
  // Allow cross-origin requests from your domain
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
        ],
      },
    ];
  },
};

export default nextConfig;
