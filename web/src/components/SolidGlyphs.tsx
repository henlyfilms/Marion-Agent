import { Phone } from 'lucide-react';

/** Solid microphone: filled capsule on a stand (like the iOS "mic.fill" symbol). */
export function MicSolid({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
      <rect x="8.25" y="1.75" width="7.5" height="13" rx="3.75" fill="currentColor" stroke="none" />
      <path d="M18.5 11a6.5 6.5 0 0 1-13 0" />
      <path d="M12 17.5V22" />
    </svg>
  );
}

/** Solid phone handset (filled, not an outline). */
export function PhoneSolid({ size = 15, className = '' }: { size?: number; className?: string }) {
  return <Phone className={`call-handset call-handset--filled ${className}`} size={size} strokeWidth={1.4} fill="currentColor" aria-hidden />;
}
