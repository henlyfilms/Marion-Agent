import { BERRY_SHAPES, BERRY_SHAPE_IDS, type BerryShape } from '@shared/avatarShapes';
import type { AvatarColor, AvatarShape } from '@shared/types';
import { BotAvatar } from './BotAvatar';

export function BotShapePicker({ shape, color, stemColor, onShape }: {
  shape: AvatarShape;
  color: AvatarColor;
  stemColor: string | null;
  onShape: (shape: BerryShape) => void;
}) {
  return (
    <div className="shape-grid" role="group" aria-label="Berry shape">
      {BERRY_SHAPE_IDS.map((id) => {
        const label = BERRY_SHAPES[id][0];
        return (
          <button key={id} type="button" aria-pressed={id === shape} aria-label={label} title={label}
            className="shape-cell" onClick={() => onShape(id)}>
            <BotAvatar shape={id} color={color} stemColor={stemColor} size={33} />
          </button>
        );
      })}
    </div>
  );
}
