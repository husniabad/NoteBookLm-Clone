/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push('pdf2pic', 'pdf2json', 'sharp');
      
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
  serverExternalPackages: ['pdf2pic', 'pdf2json', 'sharp'],
  experimental: {
    esmExternals: 'loose'
  }
};

module.exports = nextConfig;