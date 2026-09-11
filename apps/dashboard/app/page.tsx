'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '../components/SessionProvider';
import { LoadingSkeleton } from '../components/States';

export default function Home(): React.JSX.Element {
  const { token, ready } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    router.replace(token ? '/dashboard' : '/login');
  }, [ready, token, router]);

  return <LoadingSkeleton label="Loading CloudNivo" />;
}
