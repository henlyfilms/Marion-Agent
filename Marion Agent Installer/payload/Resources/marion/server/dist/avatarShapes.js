// Each shape is a silhouette assembled from overlapping, flat lobes on a 100-unit canvas.
export const BERRY_SHAPES = {
    marionberry: ['Marionberry', [[33, 35, 19], [62, 34, 20], [25, 53, 18], [71, 51, 18], [45, 54, 24], [33, 69, 17], [59, 70, 18], [46, 81, 15]]],
    blackberry: ['Blackberry', [[31, 34, 19], [56, 31, 20], [73, 44, 17], [24, 53, 18], [52, 53, 27], [74, 63, 16], [39, 72, 19], [59, 76, 17], [46, 82, 13]]],
    raspberry: ['Raspberry', [[28, 38, 18], [50, 34, 21], [74, 38, 18], [24, 55, 16], [49, 54, 25], [76, 55, 16], [36, 70, 17], [63, 70, 17], [49, 81, 14]]],
    dewberry: ['Dewberry', [[25, 43, 17], [45, 36, 20], [68, 40, 22], [78, 56, 15], [48, 56, 27], [28, 61, 18], [66, 68, 16], [44, 72, 16]]],
    cloudberry: ['Cloudberry', [[27, 48, 20], [46, 35, 22], [70, 43, 21], [78, 60, 16], [55, 57, 26], [33, 66, 20], [58, 73, 14]]],
    blueberry: ['Blueberry', [[50, 55, 34]]],
    boysenberry: ['Boysenberry', [[33, 33, 18], [58, 30, 18], [71, 49, 19], [29, 52, 19], [49, 57, 24], [36, 72, 17], [61, 73, 16], [47, 83, 13]]],
    loganberry: ['Loganberry', [[40, 31, 20], [63, 36, 17], [29, 48, 16], [69, 52, 17], [46, 54, 25], [34, 67, 15], [60, 69, 17], [47, 82, 15]]],
    tayberry: ['Tayberry', [[41, 29, 18], [60, 35, 17], [36, 48, 24], [63, 50, 19], [48, 63, 24], [42, 78, 16], [57, 78, 13]]],
    olallieberry: ['Olallieberry', [[33, 38, 20], [60, 36, 22], [22, 57, 16], [75, 53, 17], [48, 56, 27], [29, 70, 15], [59, 74, 19], [43, 79, 15]]],
    mulberry: ['Mulberry', [[31, 36, 18], [57, 30, 17], [72, 35, 15], [24, 52, 15], [45, 50, 25], [68, 53, 20], [29, 70, 16], [54, 67, 22], [43, 81, 15], [63, 83, 11]]],
    thimbleberry: ['Thimbleberry', [[25, 48, 17], [42, 38, 18], [61, 38, 18], [76, 47, 16], [24, 63, 14], [46, 59, 24], [72, 62, 16], [51, 75, 16]]],
    salmonberry: ['Salmonberry', [[36, 38, 19], [62, 34, 20], [76, 53, 16], [24, 55, 17], [49, 54, 25], [36, 73, 18], [63, 72, 18]]],
    wineberry: ['Wineberry', [[34, 39, 19], [60, 36, 20], [76, 51, 16], [23, 52, 16], [48, 54, 25], [34, 69, 16], [64, 69, 16], [49, 77, 14]]],
    huckleberry: ['Huckleberry', [[46, 57, 31], [66, 62, 20]]],
    bilberry: ['Bilberry', [[49, 55, 29], [34, 65, 17], [62, 68, 18]]],
    lingonberry: ['Lingonberry', [[50, 56, 30], [55, 70, 20]]],
    cranberry: ['Cranberry', [[39, 59, 25], [61, 58, 25], [51, 69, 22]]],
    gooseberry: ['Gooseberry', [[50, 53, 29], [50, 68, 23]]],
    currant: ['Blackcurrant', [[50, 57, 24]]],
    elderberry: ['Elderberry', [[34, 48, 17], [65, 46, 18], [49, 60, 22], [34, 69, 16], [68, 66, 16]]],
    juneberry: ['Juneberry', [[42, 51, 28], [59, 54, 27], [51, 68, 22]]],
    strawberry: ['Wild strawberry', [[33, 40, 20], [66, 39, 20], [48, 45, 25], [50, 61, 26], [50, 77, 17]]],
    honeyberry: ['Honeyberry', [[38, 58, 24], [54, 53, 25], [68, 46, 19], [30, 68, 15]]],
    funkyberry: ['Funky Berry', 'M49 14C63 13 72 23 72 35C72 40 70 44 67 47C70 55 70 63 68 66C80 65 89 74 89 84C89 95 80 99 70 98C62 98 55 94 51 89C46 96 36 100 27 97C16 94 11 86 14 77C17 68 27 64 36 66C33 57 35 47 38 42C31 35 32 25 39 19C42 16 45 15 49 14Z'],
};
export const CLASSIC_SHAPES = [
    'blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex',
    'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf',
    'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star',
];
export const BERRY_SHAPE_IDS = Object.keys(BERRY_SHAPES);
export const DEFAULT_BERRY = 'marionberry';
export const DEFAULT_STEM_COLOR = '#69864a';
export function isBerryShape(shape) {
    return typeof shape === 'string' && Object.hasOwn(BERRY_SHAPES, shape);
}
export function isStemColor(color) {
    return typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color);
}
//# sourceMappingURL=avatarShapes.js.map