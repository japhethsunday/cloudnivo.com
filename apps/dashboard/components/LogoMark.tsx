'use client';

/**
 * CloudNivo mark — an "N" (Nivo) built from ascending levels on a 24-grid.
 * Rendered in white; the tile background comes from `.brand-mark` (brand
 * blue) or the favicon file. Single source for all product surfaces.
 */
export function LogoMark({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-hidden
      style={{ display: 'block', flex: 'none' }}
    >
      <g fill="#ffffff">
        <rect x="5" y="4" width="3.4" height="16" rx="0.8" />
        <rect x="15.6" y="4" width="3.4" height="16" rx="0.8" />
        <rect x="8.4" y="10" width="2.4" height="2.4" rx="0.6" />
        <rect x="10.8" y="12.4" width="2.4" height="2.4" rx="0.6" />
        <rect x="13.2" y="14.8" width="2.4" height="2.4" rx="0.6" />
      </g>
    </svg>
  );
}
