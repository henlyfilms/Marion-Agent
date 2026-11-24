import { useEffect, useState } from 'react';
import type { NotificationKind, NotificationSettings } from '@shared/types';
import { featuresApi, type LifeLink, type PushDevice } from '../../lib/featuresApi';
import {
  currentPushSubscription, disablePush, enablePush, isIOS, isStandalone, notificationPermission, pushSupported,
  requestNotificationPermission, setNotificationSound,
} from '../../lib/notifications';
import { relativeShort } from '../../lib/time';
import { Switch } from '../config/ui';

const EVENTS: { kind: NotificationKind; title: string; sub: string }[] = [
  { kind: 'finished', title: 'A Bot replied', sub: 'When a Bot finishes answering you' },
  { kind: 'approval', title: 'Needs your OK', sub: 'A Bot is waiting for you to approve an action' },
  { kind: 'question', title: 'Questions', sub: 'A Bot asked you to choose something' },
  { kind: 'error', title: 'Problems', sub: 'A Bot couldn’t finish' },
  { kind: 'routine', title: 'Routines', sub: 'A scheduled job finished' },
  { kind: 'bot-message', title: 'Bots talking to each other', sub: 'Every hand-off between Bots (can be a lot)' },
  { kind: 'learned', title: 'Self-improvement', sub: 'A Bot learned a lesson or updated a skill' },
];

export function NotificationsSection() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [publicKey, setPublicKey] = useState('');
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [permission, setPermission] = useState(notificationPermission());
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  const load = async () => {
    const data = await featuresApi.notifications();
    setSettings(data.settings);
    setNotificationSound(data.settings.sound);
    setPublicKey(data.publicKey);
    setDevices(data.devices);
    setThisDevice((await currentPushSubscription().catch(() => null))?.endpoint ?? null);
  };
  useEffect(() => { load().catch(e => setNote({ text: (e as Error).message, error: true })); }, []);

  const save = async (patch: Partial<NotificationSettings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...patch, events: { ...settings.events, ...patch.events } });
    try {
      const result = await featuresApi.saveNotifications(patch);
      setSettings(result.settings);
      setNotificationSound(result.settings.sound);
    } catch (e) { setNote({ text: (e as Error).message, error: true }); load().catch(() => {}); }
  };

  const run = async (key: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(key); setNote(null);
    try { await action(); if (done) setNote({ text: done }); await load(); }
    catch (e) { setNote({ text: (e as Error).message, error: true }); }
    finally { setBusy(''); setPermission(notificationPermission()); }
  };

  const registered = Boolean(thisDevice && devices.some(d => d.endpoint === thisDevice));
  const electron = /Electron\//.test(navigator.userAgent);

  return (
    <>
      <div className="app-settings__head">
        <h1>Notifications</h1>
        <p>Get told when a Bot replies, needs your OK, or hits a problem, on this Mac and on your iPhone.</p>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">On this {electron ? 'Mac' : 'device'}</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Banners</div>
              <div className="cfg-row__sub">Shown when Marion Agent is in the background.{permission === 'denied' ? ' Blocked by the system: allow Marion Agent in System Settings → Notifications.' : ''}</div>
            </div>
            {permission === 'default'
              ? <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void run('perm', requestNotificationPermission)}>Allow</button>
              : <Switch on={!!settings?.desktop} label="Banners" disabled={!settings} onChange={v => void save({ desktop: v })} />}
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Sound</div>
              <div className="cfg-row__sub">A short chime with each banner.</div>
            </div>
            <Switch on={!!settings?.sound} label="Sound" disabled={!settings} onChange={v => void save({ sound: v })} />
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Show message previews</div>
              <div className="cfg-row__sub">Off shows only “Barry replied”.</div>
            </div>
            <Switch on={!!settings?.previews} label="Show message previews" disabled={!settings} onChange={v => void save({ previews: v })} />
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">iPhone and other devices</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Push notifications</div>
              <div className="cfg-row__sub">
                {electron
                  ? 'Turn this on from your iPhone: open Marion Agent from its Home Screen icon, then Settings → Notifications.'
                  : !pushSupported()
                    ? (isIOS() && !isStandalone() ? 'Add Marion Agent to your Home Screen (Share → Add to Home Screen), open it from there, then come back here.' : 'This browser can’t receive push. Use the HTTPS address in Settings → General.')
                    : registered ? 'This device gets notifications.' : 'Get notifications on this device, even when the app is closed.'}
              </div>
            </div>
            {!electron && pushSupported() && (registered
              ? <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void run('push', disablePush, 'This device won’t get notifications.')}>Turn off</button>
              : <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy || !publicKey} onClick={() => void run('push', () => enablePush(publicKey), 'This device will get notifications.')}>{busy === 'push' ? 'Turning on…' : 'Turn on'}</button>)}
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Send to devices</div>
              <div className="cfg-row__sub">Master switch for every paired device.</div>
            </div>
            <Switch on={!!settings?.push} label="Send push notifications" disabled={!settings} onChange={v => void save({ push: v })} />
          </div>
          {devices.map(device => (
            <div className="cfg-row" key={device.endpoint}>
              <div className="cfg-row__text">
                <div className="cfg-row__title">{device.label || 'Device'}{device.endpoint === thisDevice ? ' (this device)' : ''}</div>
                <div className="cfg-row__sub">Added {relativeShort(device.createdAt)}{device.lastOkAt ? ` · last delivered ${relativeShort(device.lastOkAt)}` : ''}</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--ghost-danger" disabled={!!busy} onClick={() => void run(`rm:${device.endpoint}`, async () => {
                if (device.endpoint === thisDevice) await disablePush(); else await featuresApi.removeDevice(device.endpoint);
              })}>Remove</button>
            </div>
          ))}
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Quiet hours</div>
              <div className="cfg-row__sub">No push to devices between these times (banners on the Mac still show).</div>
            </div>
            <div className="quiet-hours">
              <input type="time" className="text-input" aria-label="Quiet hours start" value={settings?.quietStart ?? ''} onChange={e => void save({ quietStart: e.target.value })} />
              <span>to</span>
              <input type="time" className="text-input" aria-label="Quiet hours end" value={settings?.quietEnd ?? ''} onChange={e => void save({ quietEnd: e.target.value })} />
            </div>
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Notify me about</div>
        <div className="cfg-card">
          {EVENTS.map(event => (
            <div className="cfg-row" key={event.kind}>
              <div className="cfg-row__text">
                <div className="cfg-row__title">{event.title}</div>
                <div className="cfg-row__sub">{event.sub}</div>
              </div>
              <Switch on={!!settings?.events[event.kind]} label={event.title} disabled={!settings} onChange={v => void save({ events: { [event.kind]: v } as NotificationSettings['events'] })} />
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void run('test', async () => {
          const result = await featuresApi.testNotification();
          setNote({ text: result.devices ? `Sent a test to ${result.delivered} of ${result.devices} device${result.devices === 1 ? '' : 's'}. Banners show here when the app is in the background.` : 'Sent a test. Banners show when the app is in the background; no phones are paired yet.' });
        })}>{busy === 'test' ? 'Sending…' : 'Send a test notification'}</button>
        {note && <p className={note.error ? 'cfg-error' : 'cfg-note'} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
      </section>
    </>
  );
}

export function LifeLinkSection() {
  const [link, setLink] = useState<LifeLink | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const load = async () => setLink(await featuresApi.lifeLink());
  useEffect(() => { load().catch(e => setNote({ text: (e as Error).message, error: true })); }, []);
  const run = async (name: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(name); setNote(null);
    try { await action(); if (done) setNote({ text: done }); await load(); }
    catch (e) { setNote({ text: (e as Error).message, error: true }); }
    finally { setBusy(''); }
  };
  const s = link?.settings;
  return (
    <>
      <div className="app-settings__head">
        <h1>Marion Life</h1>
        <p>Copy every Marion Agent chat into Marion Life, so your Second Brain can find them. Chats update about a minute after each reply.</p>
      </div>
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{s?.enabled ? `Linked to Marion Life${s.lifeEmail ? ` as ${s.lifeEmail}` : ''}` : 'Not linked'}</div>
              <div className="cfg-row__sub">
                {s?.enabled
                  ? `${s.syncedChats} chat${s.syncedChats === 1 ? '' : 's'} copied${s.lastSyncAt ? ` · last ${relativeShort(s.lastSyncAt)}` : ''}`
                  : 'In Marion Life, open Settings → Connections → Marion Agent → Connect Marion Agent, then paste the key here.'}
              </div>
            </div>
            {s?.enabled && <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy} onClick={() => void run('sync', featuresApi.syncLife, 'All chats are copied.')}>{busy === 'sync' ? 'Copying…' : 'Sync now'}</button>}
          </div>
          {s?.lastError && <div className="cfg-error cfg-error--inset">{s.lastError}</div>}
        </div>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Connection</div>
        <div className="cfg-card cfg-card--form">
          <label className="cfg-field">
            <span className="cfg-field__label">Marion Life key</span>
            <input className="text-input" type="password" autoComplete="off" value={key} placeholder={link?.hasKey ? 'Saved on this Mac. Paste a new one to replace it.' : 'mb_…'} onChange={e => setKey(e.target.value)} />
            <span className="cfg-field__hint">This key only lets Marion Agent save chat copies to your own Life account, and you can revoke it in Marion Life. It stays on this Mac and is never sent to an AI model. No database keys needed.</span>
          </label>
          <div className="cfg-actions">
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy || (!key && !link?.hasKey)}
              onClick={() => void run('save', async () => { await featuresApi.saveLifeLink({ linkKey: key || undefined }); setKey(''); }, 'Linked. Copying your chats now.')}>
              {busy === 'save' ? 'Checking…' : s?.enabled ? 'Save' : 'Link Marion Life'}
            </button>
            {s?.enabled && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => void run('pause', () => featuresApi.saveLifeLink({ enabled: false }), 'Paused. Nothing new is copied.')}>Pause</button>}
            {(s?.enabled || link?.hasKey) && <button type="button" className="cfg-btn cfg-btn--ghost-danger" disabled={!!busy} onClick={() => void run('remove', featuresApi.removeLifeLink, 'Unlinked. Chats already copied stay in Marion Life.')}>Unlink</button>}
          </div>
          {note && <p className={note.error ? 'cfg-error' : 'cfg-note'} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
        </div>
      </section>
    </>
  );
}
