import { useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { DEFAULT_STEM_COLOR, isStemColor } from '@shared/avatarShapes';

type Color = { hue: number; saturation: number; value: number };

function fromHex(hex: string): Color {
  const [r, g, b] = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
  const value = Math.max(r, g, b);
  const span = value - Math.min(r, g, b);
  const sector = span === 0 ? 0 : value === r ? (g - b) / span : value === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return { hue: (sector * 60 + 360) % 360, saturation: value ? span / value : 0, value };
}

function toHex({ hue, saturation, value }: Color) {
  const channel = (offset: number) => {
    const sector = (offset + hue / 60) % 6;
    const brightness = value * (1 - saturation * Math.max(0, Math.min(sector, 4 - sector, 1)));
    return Math.round(brightness * 255).toString(16).padStart(2, '0');
  };
  return '#' + [5, 3, 1].map(channel).join('');
}

export function BotStemPicker({ color, onChange }: {
  color: string | null;
  onChange: (color: string | null) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const lastColor = useRef(DEFAULT_STEM_COLOR);
  const [open, setOpen] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ hex: string; color: Color }>();
  const hex = color ?? lastColor.current;
  const hsv = chosen?.hex === hex ? chosen.color : fromHex(hex);
  const angle = hsv.hue * Math.PI / 180;
  const wheelStyle = {
    '--wheel-x': `${50 + 46 * hsv.saturation * Math.cos(angle)}%`,
    '--wheel-y': `${50 + 46 * hsv.saturation * Math.sin(angle)}%`,
    '--wheel-dim': 1 - hsv.value,
    '--stem-swatch': hex,
  } as CSSProperties;

  const close = () => {
    setOpen(false);
    setEdited(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const change = (next: Color) => {
    const nextHex = toHex(next);
    setChosen({ hex: nextHex, color: next });
    setEdited(null);
    onChange(nextHex);
  };
  const selectPoint = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left - box.width / 2;
    const y = event.clientY - box.top - box.height / 2;
    change({
      ...hsv,
      hue: Math.hypot(x, y) < 1 ? hsv.hue : (Math.atan2(y, x) * 180 / Math.PI + 360) % 360,
      saturation: Math.min(1, Math.hypot(x, y) / (box.width * 0.46)),
    });
  };

  return (
    <div className="stem-picker" role="group" aria-label="Berry stem" onKeyDown={event => {
      if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <div className="stem-picker__row">
        <button type="button" role="switch" aria-checked={color !== null} className="stem-picker__control"
          onClick={() => {
            if (color !== null) { lastColor.current = color; setOpen(false); setEdited(null); }
            onChange(color === null ? lastColor.current : null);
          }}>
          <span className={`toggle${color !== null ? ' is-on' : ''}`} aria-hidden="true"><span className="toggle__knob" /></span>
          Show stem
        </button>
        <button type="button" ref={trigger} disabled={color === null} className="stem-picker__control" title={hex}
          aria-controls={id} aria-expanded={open && color !== null}
          onClick={() => { setEdited(null); setOpen(current => !current); }}>
          <span className="stem-picker__swatch" style={{ '--stem-swatch': hex } as CSSProperties} aria-hidden="true" />
          Stem color
        </button>
      </div>
      {open && color !== null && (
        <div className="stem-picker__panel" id={id} style={wheelStyle}>
          <div className="stem-picker__wheel" aria-hidden="true"
            onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); selectPoint(event); }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) selectPoint(event); }}>
            <span className="stem-picker__cursor" />
          </div>
          <div className="stem-picker__adjust">
            <label>Hue<input type="range" min="0" max="359" value={Math.floor(hsv.hue)} onChange={event => change({ ...hsv, hue: +event.target.value })} /></label>
            <label>Saturation<input type="range" min="0" max="100" value={Math.round(hsv.saturation * 100)} onChange={event => change({ ...hsv, saturation: +event.target.value / 100 })} /></label>
            <label>Brightness<input type="range" min="0" max="100" value={Math.round(hsv.value * 100)} onChange={event => change({ ...hsv, value: +event.target.value / 100 })} /></label>
            <div className="stem-picker__footer">
              <input aria-label="Hex color" className="text-input stem-picker__hex" value={edited ?? hex} maxLength={7}
                spellCheck={false} autoComplete="off" onBlur={() => setEdited(null)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); close(); } }}
                onChange={event => {
                  const text = event.target.value;
                  setEdited(text);
                  const normalized = text.startsWith('#') ? text : '#' + text;
                  if (isStemColor(normalized)) { setChosen(undefined); onChange(normalized.toLowerCase()); }
                }} />
              <button className="btn btn--secondary btn--sm" type="button" onClick={close}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
