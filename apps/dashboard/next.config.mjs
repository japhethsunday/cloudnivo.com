/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@cloudnivo/api-core',
    '@cloudnivo/auth',
    '@cloudnivo/config',
    '@cloudnivo/logging',
  ],
};

export default nextConfig;
