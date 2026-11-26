import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

export type Hsv = { h: number; s: number; v: number };

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  const sector = span === 0 ? 0 : max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return { h: (sector * 60 + 360) % 360, s: max ? span / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv) {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return '#' + channel(5) + channel(3) + channel(1);
}

const isHex = (text: string) => /^#[0-9a-f]{6}$/i.test(text);
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A small, minimal color picker: a soft color field (saturation × brightness), a hue bar and a hex field.
 * Every move applies right away; there is no Done button.
 */
export function ColorPicker({ value, onChange, label = 'Color' }: { value: string; onChange: (hex: string) => void; label?: string }) {
  // Keep our own HSV so the hue doesn't snap when the color goes gray or black.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(isHex(value) ? value : '#8f59f9'));
  const emitted = useRef(value.toLowerCase());
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (isHex(value) && value.toLowerCase() !== emitted.current) { emitted.current = value.toLowerCase(); setHsv(hexToHsv(value)); }
  }, [value]);

  const apply = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    emitted.current = hex;
    setText(null);
    onChange(hex);
  };
  const hex = hsvToHex(hsv);

  const drag = (pick: (x: number, y: number) => void) => ({
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      const box = event.currentTarget.getBoundingClientRect();
      pick(clamp((event.clientX - box.left) / box.width), clamp((event.clientY - box.top) / box.height));
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const box = event.currentTarget.getBoundingClientRect();
      pick(clamp((event.clientX - box.left) / box.width), clamp((event.clientY - box.top) / box.height));
    },
  });
  const keys = (axis: 'field' | 'hue') => (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    if (axis === 'hue') apply({ ...hsv, h: (hsv.h + (dx || -dy) * 360 + 360) % 360 });
    else apply({ ...hsv, s: clamp(hsv.s + dx), v: clamp(hsv.v - dy) });
  };

  const style = { '--cp-hue': `hsl(${hsv.h} 100% 50%)`, '--cp-color': hex } as CSSProperties;
  return (
    <div className="color-picker" style={style} role="group" aria-label={label}>
      <div className="color-picker__field" tabIndex={0} role="slider" aria-label={`${label} saturation and brightness`}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        onKeyDown={keys('field')} {...drag((x, y) => apply({ ...hsv, s: x, v: 1 - y }))}>
        <span className="color-picker__thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div className="color-picker__hue" tabIndex={0} role="slider" aria-label={`${label} hue`} aria-valuemin={0} aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)} onKeyDown={keys('hue')} {...drag(x => apply({ ...hsv, h: Math.min(359.9, x * 360) }))}>
        <span className="color-picker__thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: 'var(--cp-hue)' }} />
      </div>
      <label className="color-picker__hex">
        <span className="color-picker__preview" aria-hidden="true" />
        <input aria-label={`${label} hex code`} value={text ?? hex} maxLength={7} spellCheck={false} autoComplete="off"
          onBlur={() => setText(null)}
          onChange={event => {
            const typed = event.target.value.trim();
            setText(typed);
            const normal = (typed.startsWith('#') ? typed : '#' + typed).toLowerCase();
            if (isHex(normal)) { emitted.current = normal; setHsv(hexToHsv(normal)); onChange(normal); }
          }} />
      </label>
    </div>
  );
}
