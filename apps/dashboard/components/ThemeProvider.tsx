'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'dark',
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // Dark is the console's designed scene, not a preference branch: the
  // instrument palette is authored dark-first and light is derived from it.
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const saved = window.localStorage.getItem('cloudnivo-theme') as Theme | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') setTheme(saved);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
    root.setAttribute('data-theme', effective);
    window.localStorage.setItem('cloudnivo-theme', theme);
  }, [theme]);

  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  return useContext(ThemeCtx);
}
