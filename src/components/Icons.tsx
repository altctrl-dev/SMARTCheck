import type { DriveKind, Level } from "../types";

type P = { size?: number; className?: string };

export function StatusIcon({ level, size = 16, className }: P & { level: Level }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", className, "aria-hidden": true } as const;
  if (level === "good")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7.5" fill="var(--good)" />
        <path d="M4.7 8.3l2.1 2.1 4.5-4.8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (level === "warning")
    return (
      <svg {...common}>
        <path d="M8 1.2 15.2 14H.8z" fill="var(--warning)" strokeLinejoin="round" />
        <path d="M8 5.8v3.8" stroke="#0b0b0b" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.7" r=".95" fill="#0b0b0b" />
      </svg>
    );
  if (level === "critical")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7.5" fill="var(--critical)" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="7.5" fill="var(--info)" />
      <path d="M8 7.2v4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="8" cy="4.8" r="1" fill="#fff" />
    </svg>
  );
}

export function DriveIcon({ kind, size = 20 }: P & { kind: DriveKind }) {
  if (kind === "hdd" || kind === "unknown")
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="10" cy="9" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="10" cy="9" r=".9" fill="currentColor" />
        <path d="M5.5 14h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <rect x="2" y="6" width="16" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="5" y="8.5" width="3" height="3" rx=".5" fill="currentColor" />
      <rect x="9.5" y="8.5" width="3" height="3" rx=".5" fill="currentColor" />
      <path d="M15 8.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export const RefreshIcon = ({ size = 14, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const DetailsIcon = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
    <path d="M3 4h10M3 8h10M3 12h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const CloseIcon = ({ size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const ShieldIcon = ({ size = 15 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
    <path d="M8 1.5 13.5 3.5v4.3c0 3.1-2.3 5.6-5.5 6.7-3.2-1.1-5.5-3.6-5.5-6.7V3.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);
