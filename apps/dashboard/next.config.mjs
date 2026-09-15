/** @type {import('next').NextConfig} */
// CSP connect-src must include the standalone API origin (NEXT_PUBLIC_API_URL
// is a different host in production) or every dashboard API call is blocked.
// Built dynamically so Vercel preview/production each allow their own API.
function cspValue() {
  const connect = ["'self'"];
  if (process.env.VERCEL_ENV !== 'production') {
    connect.push('http://localhost:3001', 'http://localhost:3002');
  }
  try {
    const raw = process.env.NEXT_PUBLIC_API_URL;
    if (raw) {
      const origin = new URL(raw).origin;
      if (
        (origin.startsWith('https://') || origin.startsWith('http://')) &&
        !connect.includes(origin)
      ) {
        connect.push(origin);
      }
    }
  } catch {
    // Misconfigured env: fail closed with 'self'-only (no injection).
  }
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${connect.join(' ')}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
}

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Content-Security-Policy', value: cspValue() },
        ],
      },
    ];
  },
};

export default nextConfig;
