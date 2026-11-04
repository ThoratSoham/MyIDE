import React from "react";

// 100% original geometric brand mark & bespoke mode glyphs for Nova IDE.
// Designed specifically for Nova IDE — zero copied logos, icons, or assets.

export function NovaLogoMark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="nova-prism-grad" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--nova-accent-bright, #818cf8)" />
          <stop offset="55%" stopColor="var(--nova-accent, #6366f1)" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      {/* Subtle outer orbital ring */}
      <circle
        cx="12"
        cy="12"
        r="9.25"
        stroke="url(#nova-prism-grad)"
        strokeWidth="1.25"
        strokeOpacity="0.38"
        strokeDasharray="16 5"
      />
      {/* Four-point stellar prism */}
      <path
        d="M12 2.4L14.45 9.55L21.6 12L14.45 14.45L12 21.6L9.55 14.45L2.4 12L9.55 9.55L12 2.4Z"
        fill="url(#nova-prism-grad)"
      />
      {/* Inner core facet */}
      <path
        d="M12 7.6L13.3 10.7L16.4 12L13.3 13.3L12 16.4L10.7 13.3L7.6 12L10.7 10.7L12 7.6Z"
        fill="var(--nova-bg-app, #0b0d12)"
        fillOpacity="0.65"
      />
    </svg>
  );
}

export function NovaSparkGlyph({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M8 1.2L9.65 6.35L14.8 8L9.65 9.65L8 14.8L6.35 9.65L1.2 8L6.35 6.35L8 1.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function MissionOrbitGlyph({ size = 15, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="1.75" y="2.25" width="5.25" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="2.25" width="5.25" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="1.75" y="8.75" width="5.25" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="11.6" cy="11.25" r="2.35" fill="currentColor" />
    </svg>
  );
}

