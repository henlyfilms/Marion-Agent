// 24-icon avatar catalog: unique ids, count, geometry coverage, legacy mapping and validators.
// Usage: npm run build && node tests/avatar-shapes.mjs
import assert from 'node:assert/strict';
const S = await import('../server/dist/avatarShapes.js');
const { AVATAR_GEOMETRY } = await import('../server/dist/avatarGeometry.js');

const ids = S.AVATAR_SHAPE_IDS;
assert.equal(ids.length, 24, '24 icons');
assert.equal(new Set(ids).size, ids.length, 'ids are unique');
assert.ok(ids.includes(S.DEFAULT_AVATAR_SHAPE), 'default is in the catalog');
assert.deepEqual(Object.keys(AVATAR_GEOMETRY).sort(), [...ids].sort(), 'every icon has geometry and nothing extra');
for (const id of ids) {
  assert.ok(S.AVATAR_SHAPES[id], `${id} has a label`);
  assert.ok(AVATAR_GEOMETRY[id].d.length > 10, `${id} has a silhouette`);
  assert.ok(S.isAvatarShape(id) && S.normalizeAvatarShape(id) === id, `${id} validates as itself`);
}

const legacy = Object.entries(S.LEGACY_AVATAR_SHAPES);
assert.ok(legacy.length > 0);
for (const [old, now] of legacy) {
  assert.ok(!ids.includes(old), `legacy ${old} is not a current id`);
  assert.ok(ids.includes(now), `legacy ${old} maps to a real icon`);
  assert.ok(!S.isAvatarShape(old), `${old} is not offered in the picker`);
  assert.equal(S.normalizeAvatarShape(old), now, `${old} normalizes to ${now}`);
}
assert.equal(S.normalizeAvatarShape('strawberry'), 'star');
assert.equal(S.normalizeAvatarShape(' Strawberry '), 'star', 'trimmed and case-insensitive');
for (const bad of ['nope', '', null, undefined, 7, 'constructor', '__proto__']) {
  assert.equal(S.normalizeAvatarShape(bad), null, `${String(bad)} is rejected`);
  assert.equal(S.resolveAvatarShape(bad), S.DEFAULT_AVATAR_SHAPE, `${String(bad)} resolves to the default`);
}
console.log('avatar-shapes: all checks passed');
