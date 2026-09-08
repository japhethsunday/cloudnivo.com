'use client';

import { useTheme } from './ThemeProvider';

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn"
      aria-label={`Switch to ${next} theme (current: ${theme})`}
      onClick={() => setTheme(next)}
    >
      {theme === 'dark' ? 'Light' : 'Dark'} mode
    </button>
  );
}
