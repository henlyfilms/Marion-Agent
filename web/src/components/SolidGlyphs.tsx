import { Phone } from 'lucide-react';

/**
 * The glyph is drawn at `size` but its box is rounded up to an even number of pixels (padding the
 * viewBox), so it centres exactly in an even-sized circle. An odd box (15px in a 28px button) always
 * lands half a pixel off-centre.
 */
function evenBox(size: number) {
  const box = Math.ceil(size / 2) * 2;
  const pad = ((box / size) * 24 - 24) / 2;
  return { box, viewBox: `${-pad} ${-pad} ${24 + pad * 2} ${24 + pad * 2}` };
}

/** Solid microphone: filled capsule on a stand (like the iOS "mic.fill" symbol). */
export function MicSolid({ size = 15 }: { size?: number }) {
  const { box, viewBox } = evenBox(size);
  return (
    <svg width={box} height={box} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
      <rect x="8.25" y="1.75" width="7.5" height="13" rx="3.75" fill="currentColor" stroke="none" />
      <path d="M18.5 11a6.5 6.5 0 0 1-13 0" />
      <path d="M12 17.5V22" />
    </svg>
  );
}

/** Solid phone handset (filled, not an outline). Stroke is in viewBox units, so it keeps its weight. */
export function PhoneSolid({ size = 15, className = '' }: { size?: number; className?: string }) {
  const { box, viewBox } = evenBox(size);
  return <Phone className={`call-handset call-handset--filled ${className}`} size={box} viewBox={viewBox} strokeWidth={1.4} fill="currentColor" aria-hidden />;
}
