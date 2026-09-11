'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from './SessionProvider';
import { LoadingSkeleton } from './States';

/**
 * Route gate: shows a loader while the session validates, sends visitors
 * without a session to /login, and renders children for signed-in users.
 */
export function RequireAuth({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { token, ready } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (ready && !token) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      router.replace(`/login?next=${next}`);
    }
  }, [ready, token, router]);

  if (!ready || !token) return <LoadingSkeleton label="Checking session" />;
  return <>{children}</>;
}
