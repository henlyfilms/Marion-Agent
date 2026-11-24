import crypto from 'node:crypto';
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const token = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
//# sourceMappingURL=ids.js.map