// The bot icon catalog: ids, labels, validation and legacy aliases. Silhouettes live in avatarGeometry.ts.
// Every icon is a different object (not a recolored berry) so bots stay recognizable at sidebar size.
export const AVATAR_SHAPES = {
  marionberry: 'Marionberry',
  blueberry: 'Blueberry',
  funkyberry: 'Funky Berry',
  star: 'Star',
  heart: 'Heart',
  cloud: 'Cloud',
  ghost: 'Ghost',
  rocket: 'Rocket',
  cat: 'Cat',
  bunny: 'Bunny',
  mushroom: 'Mushroom',
  cactus: 'Cactus',
  robot: 'Robot',
  chip: 'Microchip',
  gear: 'Gear',
  sun: 'Sunburst',
  flower: 'Flower',
  gem: 'Gem',
  pyramid: 'Pyramid',
  drop: 'Droplet',
  bubble: 'Speech bubble',
  capsule: 'Capsule',
  ufo: 'Flying saucer',
  plus: 'Plus',
} as const;
export type AvatarShapeId = keyof typeof AVATAR_SHAPES;
export const AVATAR_SHAPE_IDS = Object.keys(AVATAR_SHAPES) as AvatarShapeId[];
export const DEFAULT_AVATAR_SHAPE: AvatarShapeId = 'marionberry';

/**
 * Ids saved by earlier versions (27 near-identical berries and 25 plain geometric shapes) and the icon each now
 * shows. Stored rows are never rewritten: they keep their old id and render as the mapped icon.
 */
export const LEGACY_AVATAR_SHAPES = {
  blackberry: 'marionberry', raspberry: 'heart', dewberry: 'drop', cloudberry: 'cloud', boysenberry: 'bunny',
  loganberry: 'robot', tayberry: 'cat', olallieberry: 'mushroom', mulberry: 'flower', thimbleberry: 'bubble',
  salmonberry: 'sun', wineberry: 'gem', huckleberry: 'ufo', bilberry: 'plus', lingonberry: 'rocket',
  cranberry: 'chip', gooseberry: 'pyramid', currant: 'blueberry', elderberry: 'cactus', juneberry: 'gear',
  strawberry: 'star', honeyberry: 'capsule', chokeberry: 'ghost', snowberry: 'cloud',
  blob: 'blueberry', pebble: 'blueberry', egg: 'drop', bean: 'funkyberry', squircle: 'blueberry', tablet: 'capsule',
  cylinder: 'capsule', hex: 'gear', crystal: 'gem', wedge: 'pyramid', shield: 'pyramid', dome: 'ghost', arch: 'ghost',
  teardrop: 'drop', leaf: 'drop', square: 'chip', sparkle: 'sun', clover: 'flower', house: 'pyramid',
} as const satisfies Record<string, AvatarShapeId>;
export type LegacyAvatarShape = keyof typeof LEGACY_AVATAR_SHAPES;

/** True for the ids offered in the picker and accepted by tools. */
export function isAvatarShape(shape: unknown): shape is AvatarShapeId {
  return typeof shape === 'string' && Object.hasOwn(AVATAR_SHAPES, shape);
}

/** The icon an id stands for: itself, its legacy replacement, or null when it is unknown. */
export function normalizeAvatarShape(shape: unknown): AvatarShapeId | null {
  if (typeof shape !== 'string') return null;
  const id = shape.trim().toLowerCase();
  if (isAvatarShape(id)) return id;
  return Object.hasOwn(LEGACY_AVATAR_SHAPES, id) ? LEGACY_AVATAR_SHAPES[id as LegacyAvatarShape] : null;
}

/** Like normalizeAvatarShape, but unknown values show the default icon. */
export const resolveAvatarShape = (shape: unknown): AvatarShapeId => normalizeAvatarShape(shape) ?? DEFAULT_AVATAR_SHAPE;

export const DEFAULT_STEM_COLOR = '#69864a';

export const NAMED_AVATAR_COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'] as const;

/** A named bot color or a custom six-digit hex color. */
export function isAvatarColor(color: unknown): color is string {
  return (typeof color === 'string' && (NAMED_AVATAR_COLORS as readonly string[]).includes(color)) || isStemColor(color);
}

export function isStemColor(color: unknown): color is string {
  return typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color);
}

/** Working animations a bot can play around its avatar; 'auto' picks one from the bot's place in the list. */
export const WORK_FX_STYLES = ['halo', 'orbit', 'comet', 'ripple', 'sparkle', 'swirl'] as const;
export type WorkFxStyle = typeof WORK_FX_STYLES[number];
export type WorkFxChoice = WorkFxStyle | 'auto';
export const isWorkFxChoice = (v: unknown): v is WorkFxChoice => v === 'auto' || (WORK_FX_STYLES as readonly string[]).includes(v as string);
