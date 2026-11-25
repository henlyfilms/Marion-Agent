/** Usage gauge: a ring with a needle, like the usage meter in the Claude apps. Inherits currentColor. */
export function MeterIcon({ size = 18, strokeWidth = 1.8 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12.5V7.25" />
      <circle cx="12" cy="13" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}
