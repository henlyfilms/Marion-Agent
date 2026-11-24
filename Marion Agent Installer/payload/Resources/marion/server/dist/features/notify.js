import { db, now } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import { getSetting, setSetting } from './schema.js';
import { sendPush } from './webpush.js';
export const DEFAULT_NOTIFICATIONS = {
    desktop: true,
    push: true,
    events: { finished: true, approval: true, question: true, error: true, 'bot-message': false, routine: true, learned: false },
    previews: true,
    quietStart: '',
    quietEnd: '',
    sound: true,
};
export function notificationSettings(userId) {
    const saved = getSetting(userId, 'notifications', DEFAULT_NOTIFICATIONS);
    return { ...saved, events: { ...DEFAULT_NOTIFICATIONS.events, ...saved.events } };
}
export function saveNotificationSettings(userId, patch) {
    const current = notificationSettings(userId);
    const clock = (v, fallback) => typeof v === 'string' && /^(?:|[01]\d:[0-5]\d|2[0-3]:[0-5]\d)$/.test(v) ? v : fallback;
    const next = {
        desktop: typeof patch.desktop === 'boolean' ? patch.desktop : current.desktop,
        push: typeof patch.push === 'boolean' ? patch.push : current.push,
        previews: typeof patch.previews === 'boolean' ? patch.previews : current.previews,
        sound: typeof patch.sound === 'boolean' ? patch.sound : current.sound,
        quietStart: clock(patch.quietStart, current.quietStart),
        quietEnd: clock(patch.quietEnd, current.quietEnd),
        events: { ...current.events },
    };
    for (const [kind, on] of Object.entries(patch.events ?? {})) {
        if (kind in next.events && typeof on === 'boolean')
            next.events[kind] = on;
    }
    setSetting(userId, 'notifications', next);
    return next;
}
/** Minutes since local midnight for an "HH:MM" string. */
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export function inQuietHours(settings, at = new Date()) {
    if (!settings.quietStart || !settings.quietEnd || settings.quietStart === settings.quietEnd)
        return false;
    const current = at.getHours() * 60 + at.getMinutes();
    const start = minutes(settings.quietStart);
    const end = minutes(settings.quietEnd);
    return start < end ? current >= start && current < end : current >= start || current < end;
}
/** Contact for push services (RFC 8292). Never personal data: the configured HTTPS address of this workspace. */
const pushSubject = () => env.mobileAccess?.origin ?? env.browserAccess?.origin ?? 'https://marion-agent.invalid';
const recent = new Map();
/**
 * Tell the user something happened: an in-app/desktop banner through the event stream (the
 * window decides whether to show it, e.g. only while in the background) and a web push to
 * each subscribed device. Same bot + kind within 20 seconds is collapsed.
 */
export function notify(userId, input) {
    const settings = notificationSettings(userId);
    if (!settings.events[input.kind])
        return;
    const key = `${userId}:${input.botId ?? ''}:${input.kind}`;
    if ((recent.get(key) ?? 0) > now() - 20_000)
        return;
    recent.set(key, now());
    const notification = {
        id: newId('ntf'),
        kind: input.kind,
        botId: input.botId,
        title: input.title.slice(0, 80),
        body: settings.previews ? input.body.replace(/\s+/g, ' ').trim().slice(0, 180) : '',
        at: now(),
    };
    if (settings.desktop)
        hub.emit(userId, { type: 'notify', notification });
    if (settings.push && !inQuietHours(settings))
        void pushToDevices(userId, notification);
}
export async function pushToDevices(userId, notification) {
    const targets = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?').all(userId);
    let delivered = 0;
    await Promise.all(targets.map(async (target) => {
        try {
            const status = await sendPush(target, {
                title: notification.title, body: notification.body, tag: `${notification.botId ?? 'marion'}:${notification.kind}`,
                url: notification.botId ? `/?bot=${encodeURIComponent(notification.botId)}` : '/',
            }, pushSubject());
            if (status === 404 || status === 410)
                db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(target.endpoint);
            else if (status >= 200 && status < 300) {
                delivered++;
                db.prepare('UPDATE push_subscriptions SET last_ok_at=?, failures=0 WHERE endpoint=?').run(now(), target.endpoint);
            }
            else
                db.prepare('UPDATE push_subscriptions SET failures=failures+1 WHERE endpoint=?').run(target.endpoint);
        }
        catch (error) {
            console.warn('[push] delivery failed', error.message);
            db.prepare('UPDATE push_subscriptions SET failures=failures+1 WHERE endpoint=?').run(target.endpoint);
        }
    }));
    db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND failures>=8').run(userId);
    return { devices: targets.length, delivered };
}
//# sourceMappingURL=notify.js.map