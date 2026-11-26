import { AVATAR_SHAPES, AVATAR_SHAPE_IDS, resolveAvatarShape, type AvatarShapeId } from '@shared/avatarShapes';
import type { AvatarColor, AvatarShape } from '@shared/types';
import { BotAvatar } from './BotAvatar';

export function BotShapePicker({ shape, color, stemColor, glow, onShape }: {
  shape: AvatarShape;
  color: AvatarColor;
  stemColor: string | null;
  glow?: boolean;
  onShape: (shape: AvatarShapeId) => void;
}) {
  // A bot saved with an older icon id highlights the icon that now stands in for it.
  const current = resolveAvatarShape(shape);
  return (
    <div className="shape-picker">
      <div className="shape-grid" role="group" aria-label="Bot icon">
        {AVATAR_SHAPE_IDS.map((id) => {
          const label = AVATAR_SHAPES[id];
          return (
            <button key={id} type="button" aria-pressed={id === current} aria-label={label} title={label}
              className="shape-cell" onClick={() => onShape(id)}>
              <BotAvatar shape={id} color={color} stemColor={stemColor} glow={glow} size={34} />
            </button>
          );
        })}
      </div>
      <div className="shape-picker__name" aria-live="polite">{AVATAR_SHAPES[current]}</div>
    </div>
  );
}
