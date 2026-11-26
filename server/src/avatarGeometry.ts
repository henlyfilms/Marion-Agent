import type { AvatarShapeId } from './avatarShapes.js';

/**
 * Silhouettes for every bot icon, on a 100×100 canvas (bodies span roughly 4–96). Built from circles, rounded
 * polygons and a few parametric curves at load time. Every subpath winds the same way (counter-clockwise on
 * screen), so overlapping parts fill as one union under the default non-zero fill rule; holes wind the other way.
 */
export interface ShapeGeometry {
  /** Body silhouette. */
  d: string;
  /** Eye placement: centre line `y`, half-distance `dx` between the eyes, scale `s`. */
  eyes: { y: number; dx: number; s: number };
  /** Where the sprout (stem) attaches: a point on the top edge of the silhouette. */
  stem: readonly [x: number, y: number];
}

type Pt = [number, number];
const f = (n: number) => +n.toFixed(2);

/** Orient a closed point list counter-clockwise on screen (y down), matching `circle`. */
function ccw(pts: Pt[]): Pt[] {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area > 0 ? [...pts].reverse() : pts;
}

/** Polygon with every corner softened by a quadratic curve of (at most) radius `r`. */
export function roundPoly(input: Pt[], r: number): string {
  const pts = ccw(input);
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ra = Math.min(r, da / 2), rb = Math.min(r, db / 2);
    const p1: Pt = [p[0] + ((a[0] - p[0]) * ra) / da, p[1] + ((a[1] - p[1]) * ra) / da];
    const p2: Pt = [p[0] + ((b[0] - p[0]) * rb) / db, p[1] + ((b[1] - p[1]) * rb) / db];
    d += `${i === 0 ? 'M' : 'L'}${f(p1[0])} ${f(p1[1])}Q${f(p[0])} ${f(p[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** Closed Catmull-Rom spline through `input`, emitted as cubic Béziers. */
function smooth(input: Pt[]): string {
  const pts = ccw(input);
  const n = pts.length;
  const at = (i: number) => pts[(i + n) % n];
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** Sample a closed parametric curve t ∈ [0, 2π) and smooth it. */
const curve = (fn: (t: number) => Pt, steps = 48) =>
  smooth(Array.from({ length: steps }, (_, i) => fn((i / steps) * Math.PI * 2)));

/** Circle subpath (counter-clockwise). */
const circle = (cx: number, cy: number, r: number) => `M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
/** Circular hole (clockwise): subtracts from the body it sits inside. */
const hole = (cx: number, cy: number, r: number) => `M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 1 ${2 * r} 0a${r} ${r} 0 1 1 ${-2 * r} 0Z`;
const rect = (x: number, y: number, w: number, h: number, r: number) => roundPoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], r);

const ring = (n: number, radius: number, cx: number, cy: number, rot = -Math.PI / 2): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
  });

const starPts = (points: number, outer: number, inner: number, cx: number, cy: number): Pt[] =>
  Array.from({ length: points * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 ? inner : outer;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

/** Gear outline: `teeth` flat-topped teeth around a round hub. */
function gearPts(teeth: number, outer: number, inner: number, cx: number, cy: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = -Math.PI / 2 + (i / teeth) * Math.PI * 2;
    for (const [da, r] of [[-0.45, inner], [-0.27, outer], [0.27, outer], [0.45, inner]] as const) {
      pts.push([cx + r * Math.cos(a + da), cy + r * Math.sin(a + da)]);
    }
  }
  return pts;
}

const E = (y = 50, dx = 11, s = 1) => ({ y, dx, s });

type Lobe = readonly [x: number, y: number, radius: number];
const MARION_LOBES: readonly Lobe[] = [[33, 35, 19], [62, 34, 20], [25, 53, 18], [71, 51, 18], [45, 54, 24], [33, 69, 17], [59, 70, 18], [46, 81, 15]];

/** Highest point of a lobe union directly above x = 49, where the berry's stem sits. */
const lobeTop = (lobes: readonly Lobe[], x = 49): readonly [number, number] =>
  [x, Math.min(...lobes.filter(([cx, , r]) => Math.abs(x - cx) < r).map(([cx, cy, r]) => cy - Math.sqrt(r * r - (x - cx) ** 2)))];

const GEOMETRY: Record<AvatarShapeId, ShapeGeometry> = {
  // Berries kept from the old set: a bumpy cluster, a plain round fruit, and the freeform blob.
  marionberry: { d: MARION_LOBES.map(([x, y, r]) => circle(x, y, r)).join(''), eyes: { y: 53, dx: 12.5, s: 0.9 }, stem: lobeTop(MARION_LOBES) },
  blueberry: { d: circle(50, 55, 34), eyes: { y: 53, dx: 12.5, s: 0.9 }, stem: [49, 21] },
  funkyberry: {
    d: 'M49 14C63 13 72 23 72 35C72 40 70 44 67 47C70 55 70 63 68 66C80 65 89 74 89 84C89 95 80 99 70 98C62 98 55 94 51 89C46 96 36 100 27 97C16 94 11 86 14 77C17 68 27 64 36 66C33 57 35 47 38 42C31 35 32 25 39 19C42 16 45 15 49 14Z',
    eyes: { y: 52, dx: 8.5, s: 0.76 }, stem: [50, 14],
  },
  // Symbols and weather.
  star: { d: roundPoly(starPts(5, 48, 26, 50, 55), 7), eyes: E(56, 8.5, 0.85), stem: [50, 11] },
  heart: {
    d: curve((t) => {
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      return [50 + 2.7 * x, 43 - 2.7 * y];
    }, 72),
    eyes: E(44, 11), stem: [50, 30],
  },
  cloud: { d: circle(27, 60, 18) + circle(48, 44, 24) + circle(72, 56, 20) + rect(12, 58, 78, 26, 13), eyes: E(60), stem: [48, 20] },
  ghost: { d: 'M86 46A36 36 0 0 0 14 46V84Q23 100 32 84Q41 100 50 84Q59 100 68 84Q77 100 86 84Z', eyes: E(46, 12), stem: [50, 10] },
  rocket: {
    d: 'M50 4C30 18 26 42 28 66L28 78L72 78L72 66C74 42 70 18 50 4Z'
      + roundPoly([[31, 48], [9, 78], [9, 91], [34, 84]], 3) + roundPoly([[69, 48], [91, 78], [91, 91], [66, 84]], 3)
      + roundPoly([[38, 76], [62, 76], [50, 97]], 5),
    eyes: E(46, 9, 0.9), stem: [50, 5],
  },
  // Critters.
  cat: {
    d: circle(50, 58, 35) + roundPoly([[12, 8], [47, 27], [16, 58]], 5) + roundPoly([[88, 8], [53, 27], [84, 58]], 5),
    eyes: E(60, 14), stem: [50, 23],
  },
  bunny: { d: circle(50, 64, 31) + rect(27, 3, 16, 48, 8) + rect(57, 3, 16, 48, 8), eyes: E(64, 12), stem: [50, 33] },
  // Things and places.
  mushroom: {
    d: 'M92 58A42 38 0 0 0 8 58Q8 66 16 66L84 66Q92 66 92 58Z'
      + rect(34, 60, 32, 32, 12) + hole(50, 29, 4) + hole(23, 47, 5) + hole(77, 47, 5),
    eyes: E(47, 13, 0.85), stem: [50, 20],
  },
  cactus: {
    d: rect(34, 8, 32, 84, 16) + rect(10, 46, 34, 16, 8) + rect(10, 26, 16, 36, 8) + rect(56, 54, 34, 16, 8) + rect(74, 34, 16, 36, 8),
    eyes: E(34, 8.5, 0.8), stem: [50, 8],
  },
  robot: { d: rect(14, 28, 72, 62, 16) + rect(46, 12, 8, 20, 4) + circle(50, 11, 6) + rect(5, 48, 12, 24, 5) + rect(83, 48, 12, 24, 5), eyes: E(55, 15), stem: [50, 5] },
  chip: {
    d: rect(20, 20, 60, 60, 10)
      + [30, 46, 62].map((x) => rect(x, 6, 8, 18, 3) + rect(x, 76, 8, 18, 3) + rect(6, x, 18, 8, 3) + rect(76, x, 18, 8, 3)).join(''),
    eyes: E(50, 11), stem: [50, 6],
  },
  gear: { d: roundPoly(gearPts(6, 46, 35, 50, 50), 3), eyes: E(50, 12), stem: [50, 6] },
  sun: { d: roundPoly(starPts(12, 48, 31, 50, 50), 2.5), eyes: E(50, 11), stem: [50, 3] },
  flower: { d: ring(6, 30, 50, 50).map(([x, y]) => circle(x, y, 14)).join('') + circle(50, 50, 22), eyes: E(50, 10), stem: [50, 6] },
  gem: { d: roundPoly([[28, 14], [72, 14], [93, 38], [50, 90], [7, 38]], 6), eyes: E(40, 11, 0.9), stem: [50, 14] },
  pyramid: { d: roundPoly([[50, 8], [93, 86], [7, 86]], 10), eyes: E(67, 10, 0.85), stem: [50, 10] },
  drop: { d: curve((t) => [50 + 46 * Math.sin(t) * Math.sin(t / 2), 52 - 42 * Math.cos(t)], 56), eyes: E(62, 11), stem: [50, 10] },
  bubble: { d: rect(8, 10, 84, 62, 24) + roundPoly([[20, 62], [48, 62], [16, 92]], 4), eyes: E(41, 13), stem: [50, 10] },
  capsule: { d: rect(26, 5, 48, 90, 24), eyes: E(40, 10), stem: [50, 5] },
  ufo: { d: 'M74 56A24 24 0 0 0 26 56Z' + curve((t) => [50 + 45 * Math.cos(t), 68 + 19 * Math.sin(t)]), eyes: E(66, 16, 0.8), stem: [50, 32] },
  plus: { d: rect(33, 6, 34, 88, 13) + rect(6, 33, 88, 34, 13), eyes: E(50, 10, 0.95), stem: [50, 6] },
};

export const AVATAR_GEOMETRY: Readonly<Record<AvatarShapeId, ShapeGeometry>> = GEOMETRY;
