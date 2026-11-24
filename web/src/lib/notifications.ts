import type { AppNotification } from '@shared/types';
import { featuresApi } from './featuresApi';
import { playDictationSound } from '../voice/sounds';

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

/** Show a server notification. In the foreground, approvals and errors become a toast; in the background, a system banner. */
export function showNotification(notification: AppNotification) {
  const background = document.visibilityState !== 'visible' || !document.hasFocus();
  if (!background) {
    if (notification.kind === 'approval' || notification.kind === 'error' || notification.kind === 'learned') {
      window.dispatchEvent(new CustomEvent('marion-agent:toast', { detail: notification }));
    }
    return;
  }
  if (!canNotify() || Notification.permission !== 'granted') return;
  try {
    const banner = new Notification(notification.title, {
      body: notification.body, tag: `${notification.botId ?? 'marion'}:${notification.kind}`, icon: '/app-192.png', silent: !soundOn,
    });
    banner.onclick = () => {
      window.focus();
      if (notification.botId) window.dispatchEvent(new CustomEvent('marion-agent:open-bot', { detail: notification.botId }));
      banner.close();
    };
    if (soundOn) playDictationSound(false);
  } catch { /* Some browsers only allow notifications from a service worker. */ }
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
