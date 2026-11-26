import { useId, useState } from 'react';
import type { AvatarColor } from '@shared/types';
import { Icon } from '../components/Icon';
import { ColorPicker } from '../components/ColorPicker';
import { Reveal, useOnlyOneOpen } from '../components/Reveal';
import { COLOR_ORDER, isHexColor, palette } from '../lib/colors';

/** The named bot colors plus a rainbow swatch that opens the color picker for any color. */
export function BotColorPicker({ color, onChange }: { color: AvatarColor; onChange: (color: AvatarColor) => void }) {
  const name = useId();
  const custom = isHexColor(color);
  const [open, setOpen] = useState(false);
  useOnlyOneOpen(open, () => setOpen(false));
  return (
    <div className="color-choice" onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <div className="swatches" role="radiogroup" aria-label="Character color">
        {COLOR_ORDER.map(choice => (
          <label className="swatch-cell" key={choice} title={choice}>
            <input type="radio" name={name} aria-label={choice} checked={choice === color} onChange={() => { setOpen(false); onChange(choice); }} />
            <span className="swatch" style={{ background: palette(choice).fill }}>
              {choice === color && <Icon name="check" size={13} />}
            </span>
          </label>
        ))}
        <label className="swatch-cell" title="Custom color">
          <input type="radio" name={name} aria-label="Custom color" checked={custom} aria-expanded={open}
            onChange={() => setOpen(true)} onClick={() => { if (custom) setOpen(current => !current); }} />
          <span className={`swatch swatch--rainbow${custom ? ' is-custom' : ''}`} style={custom ? { '--swatch-custom': color } as React.CSSProperties : undefined}>
            {custom && <Icon name="check" size={13} />}
          </span>
        </label>
      </div>
      <Reveal open={open} className="color-choice__panel">
        <ColorPicker label="Bot color" value={custom ? color : palette(color).fill.startsWith('#') ? palette(color).fill : '#8f59f9'}
          onChange={hex => onChange(hex as AvatarColor)} />
      </Reveal>
    </div>
  );
}
