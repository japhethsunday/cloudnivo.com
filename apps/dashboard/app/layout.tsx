import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AppShell } from '../components/AppShell';
import { SessionProvider } from '../components/SessionProvider';
import { ThemeProvider } from '../components/ThemeProvider';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

/**
 * Rendered per request, never prerendered at build time. The CSP in
 * middleware.ts is nonce-based, and a nonce only exists once a request does:
 * a statically prerendered page bakes its inline RSC bootstrap scripts into
 * HTML with no nonce, and the browser then refuses every one of them, so the
 * app never hydrates. These pages are client-rendered shells that fetch live
 * data from the API, so there is no prerender value to lose.
 */
export const dynamic = 'force-dynamic';

/**
 * `metadataBase` is the canonical production origin: Next resolves every
 * relative metadata URL (canonical links, Open Graph, Twitter images) against
 * it. The apex is canonical — cloudnivo.org, not www — so a page that later
 * declares `alternates.canonical` or an OG image resolves to one host instead
 * of whichever one the visitor happened to arrive on.
 */
export const metadata: Metadata = {
  metadataBase: new URL('https://cloudnivo.org'),
  title: 'CloudNivo — Backend as a Service',
  description: 'Developer-focused control plane for projects, auth, storage, and APIs.',
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider>
          <SessionProvider>
            <a className="skip-link" href="#main">
              Skip to content
            </a>
            <AppShell>{children}</AppShell>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
