'use client';

import { useTheme } from './ThemeProvider';
import { IconMonitor, IconMoon, IconSun } from './icons';

const OPTIONS: { value: 'light' | 'dark' | 'system'; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <IconSun size={14} /> },
  { value: 'dark', label: 'Dark', icon: <IconMoon size={14} /> },
  { value: 'system', label: 'System', icon: <IconMonitor size={14} /> },
];

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-switch" role="group" aria-label="Theme preference">
      {OPTIONS.map(o => (
        <button
          key={o.value}
          type="button"
          className={theme === o.value ? 'active' : ''}
          aria-pressed={theme === o.value}
          aria-label={`${o.label} theme`}
          onClick={() => setTheme(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}