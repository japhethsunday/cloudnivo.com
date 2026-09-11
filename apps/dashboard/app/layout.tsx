import type { Metadata } from 'next';
import { AppShell } from '../components/AppShell';
import { SessionProvider } from '../components/SessionProvider';
import { ThemeProvider } from '../components/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'CloudNivo — Backend as a Service',
  description: 'Developer-focused control plane for projects, auth, storage, and APIs.',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
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
