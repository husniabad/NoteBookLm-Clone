/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push('pdf2pic', 'sharp');
      
      // Ignore test files and problematic paths
      config.resolve.alias = {
        ...config.resolve.alias,
        './test/data/05-versions-space.pdf': false,
      };
      
      config.module.rules.push({
        test: /\.pdf$/,
        use: 'ignore-loader'
      });
    }
    return config;
  },
  serverExternalPackages: ['pdf2pic', 'sharp'],
  experimental: {
    esmExternals: 'loose'
  }
};

module.exports = nextConfig;