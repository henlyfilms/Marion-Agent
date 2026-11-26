import { db, now } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { newId } from '../lib/ids.js';
import { plainLine } from '../lib/plainText.js';
import { describeMacBlock, type MacBlock } from '../lib/macPermissions.js';
import type { AppNotification, NotificationKind, NotificationSettings } from '../types.js';
import { getSetting, setSetting } from './schema.js';
import { sendPush } from './webpush.js';

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  desktop: true,
  push: true,
  events: { finished: true, approval: true, question: true, error: true, 'bot-message': false, routine: true, learned: false },
  previews: true,
  quietStart: '',
  quietEnd: '',
  sound: true,
};

export function notificationSettings(userId: string): NotificationSettings {
  const saved = getSetting<NotificationSettings>(userId, 'notifications', DEFAULT_NOTIFICATIONS);
  return { ...saved, events: { ...DEFAULT_NOTIFICATIONS.events, ...saved.events } };
}

export function saveNotificationSettings(userId: string, patch: Partial<NotificationSettings>) {
  const current = notificationSettings(userId);
  const clock = (v: unknown, fallback: string) => typeof v === 'string' && /^(?:|[01]\d:[0-5]\d|2[0-3]:[0-5]\d)$/.test(v) ? v : fallback;
  const next: NotificationSettings = {
    desktop: typeof patch.desktop === 'boolean' ? patch.desktop : current.desktop,
    push: typeof patch.push === 'boolean' ? patch.push : current.push,
    previews: typeof patch.previews === 'boolean' ? patch.previews : current.previews,
    sound: typeof patch.sound === 'boolean' ? patch.sound : current.sound,
    quietStart: clock(patch.quietStart, current.quietStart),
    quietEnd: clock(patch.quietEnd, current.quietEnd),
    events: { ...current.events },
  };
  for (const [kind, on] of Object.entries(patch.events ?? {})) {
    if (kind in next.events && typeof on === 'boolean') next.events[kind as NotificationKind] = on;
  }
  setSetting(userId, 'notifications', next);
  return next;
}

/** Minutes since local midnight for an "HH:MM" string. */
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuietHours(settings: NotificationSettings, at = new Date()) {
  if (!settings.quietStart || !settings.quietEnd || settings.quietStart === settings.quietEnd) return false;
  const current = at.getHours() * 60 + at.getMinutes();
  const start = minutes(settings.quietStart);
  const end = minutes(settings.quietEnd);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Contact for push services (RFC 8292). Never personal data: the configured HTTPS address of this workspace. */
const pushSubject = () => env.mobileAccess?.origin ?? env.browserAccess?.origin ?? 'https://marion-agent.invalid';

const recent = new Map<string, number>();

/** What the bot is telling you, shown under its name: "Barry · Has a question". */
const STATUS: Record<NotificationKind, string> = {
  finished: 'Finished', approval: 'Needs your OK', question: 'Has a question', error: 'Hit a problem',
  'bot-message': 'Sent a message', routine: 'Routine report', learned: 'Learned something',
};

/**
 * Tell the user something happened: an in-app/desktop banner through the event stream (the
 * window decides whether to show it, e.g. only while in the background) and a web push to
 * each subscribed device. Same bot + kind within 20 seconds is collapsed.
 */
export function notify(userId: string, input: { kind: NotificationKind; botId?: string; title: string; body: string }) {
  const settings = notificationSettings(userId);
  if (!settings.events[input.kind]) return;
  const key = `${userId}:${input.botId ?? ''}:${input.kind}`;
  if ((recent.get(key) ?? 0) > now() - 20_000) return;
  recent.set(key, now());
  const bot = input.botId ? db.prepare('SELECT name FROM bots WHERE id=?').get(input.botId) as { name: string } | undefined : undefined;
  const notification: AppNotification = {
    id: newId('ntf'),
    kind: input.kind,
    botId: input.botId,
    botName: bot?.name,
    status: STATUS[input.kind],
    // Notifications are plain text: no Markdown symbols (**, `, #, [x](y) ...) on any surface.
    title: plainLine(input.title).slice(0, 80),
    body: settings.previews ? plainLine(input.body).slice(0, 180) : '',
    at: now(),
  };
  if (settings.desktop) hub.emit(userId, { type: 'notify', notification });
  if (settings.push && !inQuietHours(settings)) void pushToDevices(userId, notification);
}

/**
 * macOS stopped Marion Agent from doing something (Accessibility, Automation, Speech, Screen Recording, protected
 * folders). Always shown in the app, whatever the notification settings say, because the user has to act:
 * it says what Marion Agent was trying to do and what macOS blocked.
 */
export function notifyMacBlocked(userId: string, block: MacBlock, botId?: string) {
  const key = `${userId}:mac:${block.doing}:${block.blocked}`;
  if ((recent.get(key) ?? 0) > now() - 10_000) return;
  recent.set(key, now());
  const bot = botId ? db.prepare('SELECT name FROM bots WHERE id=?').get(botId) as { name: string } | undefined : undefined;
  hub.emit(userId, { type: 'notify', notification: {
    id: newId('ntf'), kind: 'error', botId, botName: bot?.name, status: 'macOS blocked this',
    title: 'macOS blocked Marion Agent',
    body: `Trying to: ${block.doing}. Blocked: ${block.blocked}. To allow it: ${block.fix}.`,
    at: now(),
  } });
}

export const macBlockMessage = describeMacBlock;

export async function pushToDevices(userId: string, notification: AppNotification) {
  const targets = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?').all(userId) as { endpoint: string; p256dh: string; auth: string }[];
  let delivered = 0;
  await Promise.all(targets.map(async target => {
    try {
      const status = await sendPush(target, {
        // On a phone the banner leads with the bot's name, then what it needs and what it said.
        title: plainLine(notification.botName ?? notification.title),
        body: plainLine(notification.botName ? [notification.status, notification.body].filter(Boolean).join(' · ') : notification.body), tag: `${notification.botId ?? 'marion'}:${notification.kind}`,
        url: notification.botId ? `/?bot=${encodeURIComponent(notification.botId)}` : '/',
      }, pushSubject());
      if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(target.endpoint);
      else if (status >= 200 && status < 300) {
        delivered++;
        db.prepare('UPDATE push_subscriptions SET last_ok_at=?, failures=0 WHERE endpoint=?').run(now(), target.endpoint);
      } else db.prepare('UPDATE push_subscriptions SET failures=failures+1 WHERE endpoint=?').run(target.endpoint);
    } catch (error) {
      console.warn('[push] delivery failed', (error as Error).message);
      db.prepare('UPDATE push_subscriptions SET failures=failures+1 WHERE endpoint=?').run(target.endpoint);
    }
  }));
  db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND failures>=8').run(userId);
  return { devices: targets.length, delivered };
}
