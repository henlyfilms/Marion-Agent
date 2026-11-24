import { useId } from 'react';
import type { AvatarColor } from '@shared/types';
import { Icon } from '../components/Icon';
import { COLOR_ORDER, palette } from '../lib/colors';

export function BotColorPicker({ color, onChange }: { color: AvatarColor; onChange: (color: AvatarColor) => void }) {
  const name = useId();
  return (
    <div className="swatches" role="radiogroup" aria-label="Character color">
      {COLOR_ORDER.map(choice => (
        <label className="swatch-cell" key={choice} title={choice}>
          <input type="radio" name={name} aria-label={choice} checked={choice === color} onChange={() => onChange(choice)} />
          <span className="swatch" style={{ background: palette(choice).fill }}>
            {choice === color && <Icon name="check" size={13} />}
          </span>
        </label>
      ))}
    </div>
  );
}
