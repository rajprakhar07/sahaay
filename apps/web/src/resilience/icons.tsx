/**
 * Small status icons. Every status in the resilience UI is shown with an icon
 * AND text, so meaning never depends on color alone.
 */
export type IconKind =
  | "check" // resolved / fully recovered
  | "cross" // unresolved / recovery failed
  | "ban" // blocked
  | "warn" // disrupted
  | "minus" // unavailable in the model
  | "half"; // partially recovered

interface IconProps {
  kind: IconKind;
  size?: number;
  /** Position when nested inside an <svg>. */
  x?: number;
  y?: number;
  className?: string;
}

export function Icon({ kind, size = 14, x, y, className }: IconProps) {
  return (
    <svg
      className={`rm-icon rm-icon--${kind}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...(x !== undefined ? { x } : {})}
      {...(y !== undefined ? { y } : {})}
    >
      {kind === "check" && <path d="M2 6.5 5 9.5 10.2 2.8" />}
      {kind === "cross" && <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />}
      {kind === "ban" && (
        <>
          <circle cx="6" cy="6" r="4.6" />
          <path d="M2.8 9.2 9.2 2.8" />
        </>
      )}
      {kind === "warn" && (
        <>
          <path d="M6 1.4 11 10.4H1Z" />
          <path d="M6 4.8v2.6" />
          <path d="M6 9v.01" />
        </>
      )}
      {kind === "minus" && (
        <>
          <circle cx="6" cy="6" r="4.6" />
          <path d="M3.8 6h4.4" />
        </>
      )}
      {kind === "half" && (
        <>
          <circle cx="6" cy="6" r="4.6" />
          <path d="M6 1.4a4.6 4.6 0 0 1 0 9.2Z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
