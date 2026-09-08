import type { Metadata } from 'next';
import { SideNav } from '../components/SideNav';
import { ThemeProvider } from '../components/ThemeProvider';
import { ThemeToggle } from '../components/ThemeToggle';
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
          <a className="skip-link" href="#main">
            Skip to content
          </a>
          <div className="shell">
            <aside className="sidebar" aria-label="Sidebar">
              <div className="brand">CloudNivo</div>
              <SideNav />
              <div style={{ marginTop: 'auto' }}>
                <ThemeToggle />
              </div>
            </aside>
            <main id="main" className="main" tabIndex={-1}>
              {children}
            </main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
