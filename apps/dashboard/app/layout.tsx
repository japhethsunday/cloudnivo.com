import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AppShell } from '../components/AppShell';
import { SessionProvider } from '../components/SessionProvider';
import { ThemeProvider } from '../components/ThemeProvider';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
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
