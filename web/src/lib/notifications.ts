import type { AppNotification } from '@shared/types';
import { featuresApi } from './featuresApi';
import { playDictationSound } from '../voice/sounds';
import { plainLine } from '@shared/lib/plainText';

/** The same notification with every field as plain text (no raw Markdown symbols), whatever surface shows it. */
export const plainNotification = (n: AppNotification): AppNotification => ({
  ...n, title: plainLine(n.title), body: plainLine(n.body), ...(n.status ? { status: plainLine(n.status) } : {}),
});

const canNotify = () => typeof Notification !== 'undefined';
export const notificationPermission = () => (canNotify() ? Notification.permission : 'unsupported') as NotificationPermission | 'unsupported';
export const pushSupported = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window;
/** iOS only delivers web push to apps added to the Home Screen. */
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function requestNotificationPermission() {
  if (!canNotify()) return 'unsupported' as const;
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/** Open a bot from a notification click or a ?bot= link. */
export function openFromLink(url: string) {
  const id = new URL(url, location.origin).searchParams.get('bot');
  if (!id) return;
  window.dispatchEvent(new CustomEvent('marion-agent:open-bot', { detail: id }));
}

let soundOn = true;
export const setNotificationSound = (on: boolean) => { soundOn = on; };

/** A rendered bot avatar from the sidebar as a PNG data URL, for system banners. Cached per bot look. */
const avatarCache = new Map<string, string>();
async function botIcon(botId: string): Promise<string | undefined> {
  const svg = document.querySelector<SVGSVGElement>(`[data-chat-id="${CSS.escape(botId)}"] .bot-row__avatar svg`);
  if (!svg) return undefined;
  const markup = new XMLSerializer().serializeToString(svg);
  const cached = avatarCache.get(markup);
  if (cached) return cached;
  try {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    canvas.getContext('2d')!.drawImage(image, 8, 8, 112, 112);
    const url = canvas.toDataURL('image/png');
    avatarCache.set(markup, url);
    return url;
  } catch { return undefined; }
}

/** Ignore the same bot + kind arriving twice within a few seconds (the completion event and the server notice). */
const lastShown = new Map<string, number>();
function isRepeat(notification: AppNotification) {
  const key = `${notification.botId ?? ''}:${notification.kind}`;
  const repeat = Date.now() - (lastShown.get(key) ?? 0) < 5000;
  lastShown.set(key, Date.now());
  return repeat;
}

/**
 * Show a notification. In the foreground it becomes an in-app banner with the bot's icon and name
 * (skipped for a plain reply in the chat you're already reading); in the background, a system banner.
 */
export function showNotification(incoming: AppNotification, viewingBotId?: string | null) {
  const notification = plainNotification(incoming);
  if (isRepeat(notification)) return;
  const background = document.visibilityState !== 'visible' || !document.hasFocus();
  if (!background) {
    const quiet = notification.botId && notification.botId === viewingBotId && ['finished', 'routine', 'bot-message'].includes(notification.kind);
    if (!quiet) window.dispatchEvent(new CustomEvent('marion-agent:toast', { detail: notification }));
    return;
  }
  if (!canNotify() || Notification.permission !== 'granted') return;
  const title = notification.botName ?? notification.title;
  const body = notification.botName ? [notification.status, notification.body].filter(Boolean).join(' · ') : notification.body;
  void (notification.botId ? botIcon(notification.botId) : Promise.resolve(undefined)).then(icon => {
    try {
      const banner = new Notification(title, {
        body, tag: `${notification.botId ?? 'marion'}:${notification.kind}`, icon: icon ?? '/app-192.png', silent: true,
      });
      banner.onclick = () => {
        window.focus();
        if (notification.botId) window.dispatchEvent(new CustomEvent('marion-agent:open-bot', { detail: notification.botId }));
        banner.close();
      };
      if (soundOn) playDictationSound(false);
    } catch { /* Some browsers only allow notifications from a service worker. */ }
  });
}

export async function registerServiceWorker() {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'marion-open' && typeof event.data.url === 'string') openFromLink(event.data.url);
    });
    return registration;
  } catch {
    return null;
  }
}

function base64UrlBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || isIOS()) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Electron\//.test(ua)) return 'Mac app';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  if (/Windows/.test(ua)) return 'Windows browser';
  return 'Browser';
}

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

/** Turn on push for this device and register it with the Mac. */
export async function enablePush(publicKey: string) {
  if (!pushSupported()) throw new Error(isIOS() && !isStandalone()
    ? 'On iPhone, open Marion Agent from its Home Screen icon first (Share → Add to Home Screen), then turn this on.'
    : 'This browser can’t receive push notifications. Open Marion Agent over its HTTPS address.');
  const permission = await requestNotificationPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for Marion Agent. Allow them in Settings → Notifications on this device.');
  const registration = (await navigator.serviceWorker.getRegistration('/')) ?? await registerServiceWorker();
  if (!registration) throw new Error('Couldn’t start the notification service.');
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(publicKey) });
  await featuresApi.addDevice(subscription.toJSON(), deviceLabel());
  return subscription;
}

export async function disablePush() {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await featuresApi.removeDevice(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}
