import { useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_STEM_COLOR } from '@shared/avatarShapes';
import { ColorPicker } from '../components/ColorPicker';
import { Icon } from '../components/Icon';
import { Reveal, useOnlyOneOpen } from '../components/Reveal';

/** Stem colors one click away; the rainbow swatch opens the picker for anything else. */
const STEM_PRESETS = ['#69864a', '#3f7a3c', '#9bb85a', '#8a6236', '#c79a2e', '#d65a6a', '#4f7fae'];

/** "Show stem" and "Glow" switches, then the stem colors. Picking a color applies it straight away. */
export function BotStemPicker({ color, onChange, glow, onGlow }: {
  color: string | null;
  onChange: (color: string | null) => void;
  glow?: boolean;
  onGlow?: (on: boolean) => void;
}) {
  const lastColor = useRef(DEFAULT_STEM_COLOR);
  const [custom, setCustom] = useState(false);
  useOnlyOneOpen(custom, () => setCustom(false));
  if (color) lastColor.current = color;
  const shown = color ?? lastColor.current;
  const isPreset = STEM_PRESETS.includes(shown.toLowerCase());

  return (
    <div className="stem-picker" role="group" aria-label="Berry stem and glow" onKeyDown={event => {
      if (custom && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCustom(false); }
    }}>
      <div className="stem-picker__row">
        <button type="button" role="switch" aria-checked={color !== null} className="stem-picker__control"
          onClick={() => { if (color !== null) setCustom(false); onChange(color === null ? lastColor.current : null); }}>
          <span className={`toggle${color !== null ? ' is-on' : ''}`} aria-hidden="true"><span className="toggle__knob" /></span>
          Show stem
        </button>
        {onGlow && (
          <button type="button" role="switch" aria-checked={!!glow} className="stem-picker__control" onClick={() => onGlow(!glow)}>
            <span className={`toggle${glow ? ' is-on' : ''}`} aria-hidden="true"><span className="toggle__knob" /></span>
            Glow
          </button>
        )}
      </div>
      <Reveal open={color !== null} className="stem-picker__colors">
        <div className="swatches swatches--small" role="radiogroup" aria-label="Stem color">
          {STEM_PRESETS.map(preset => (
            <button key={preset} type="button" role="radio" aria-checked={shown.toLowerCase() === preset} aria-label={`Stem ${preset}`} title={preset}
              className="swatch-cell" onClick={() => { setCustom(false); onChange(preset); }}>
              <span className="swatch" style={{ background: preset }}>{shown.toLowerCase() === preset && <Icon name="check" size={11} />}</span>
            </button>
          ))}
          <button type="button" role="radio" aria-checked={!isPreset} aria-expanded={custom} aria-label="Custom stem color" title="Custom stem color"
            className="swatch-cell" onClick={() => setCustom(current => !current)}>
            <span className={`swatch swatch--rainbow${!isPreset ? ' is-custom' : ''}`} style={!isPreset ? { '--swatch-custom': shown } as CSSProperties : undefined}>
              {!isPreset && <Icon name="check" size={11} />}
            </span>
          </button>
        </div>
        <Reveal open={custom && color !== null} className="color-choice__panel">
          <ColorPicker label="Stem color" value={shown} onChange={onChange} />
        </Reveal>
      </Reveal>
    </div>
  );
}
