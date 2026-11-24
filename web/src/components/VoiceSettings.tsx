import { useEffect, useState } from 'react';
import type { Bot, ChatModel } from '@shared/types';
import { Phone, PhoneOff } from 'lucide-react';
import { configApi } from '../lib/configApi';
import { callModelFor, endLocalCall, isLocalCallActive, setChatCallModel, setDefaultCallModel, defaultCallModel, startLocalCall, useLocalCall } from '../voice/localCall';
import { useStore } from '../store';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { endCall, isCallActive, previewVoice, startCall, useVoice } from '../voice/call';
import { Icon } from './Icon';

const FALLBACK: VoiceOptions = {
  voices: ['ara', 'eve', 'leo', 'luna', 'rex', 'sal'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;

function NativeSelect<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  return (
    <span className="mini-select mini-select--native">
      <span>{current}</span>
      <Icon name="chev_down" size={10} opacity={0.66} />
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </span>
  );
}

/** "Voice chat" section of the details panel: voice, speed, language (saved per bot), preview, start a call. */
export function VoiceSettings({ bot }: { bot: Bot }) {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  const [availability, setAvailability] = useState<Awaited<ReturnType<typeof voiceApi.status>>>();
  const localCall = useLocalCall(s => s.botId === bot.id && isLocalCallActive(s));
  useLocalCall(s => s.status);
  const [models, setModels] = useState<ChatModel[]>([]);
  useEffect(() => {
    if (!availability?.localSpeech) return;
    configApi.chatModels(bot.id, true).then(result => setModels(result.models)).catch(() => {});
  }, [bot.id, availability?.localSpeech]);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  useEffect(() => {
    voiceApi.status().then(status => {
      setAvailability(status);
      if (status.realtime && !status.localSpeech) voiceApi.options().then(setOpts).catch(() => {});
    }).catch(() => {});
  }, []);
  useEffect(() => setError(null), [bot.id]);

  const save = async (patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage'>>) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    // Optimistic; the server's `bot` event confirms.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, voice: prev.voice, voiceSpeed: prev.voiceSpeed, voiceLanguage: prev.voiceLanguage } : b)) }));
      setError('Couldn’t save that setting.');
    }
  };

  const preview = async () => {
    if (previewing) return;
    setPreviewing(true); setError(null);
    try { await previewVoice({ botId: bot.id, voice: bot.voice, speed: bot.voiceSpeed, language: bot.voiceLanguage }); }
    catch (e) { setError((e as Error).message || 'Preview unavailable'); }
    finally { setPreviewing(false); }
  };

  if (!availability?.realtime || availability.localSpeech) {
    const chosen = callModelFor(bot.id);
    const key = (m: { provider: string; model: string }) => `${m.provider}:${m.model}`;
    const modelOptions = [{ value: '', label: `Same as chat` }, ...models.map(m => ({ value: key({ provider: m.provider, model: m.id }), label: m.label }))];
    const pick = (value: string, all: boolean) => {
      const m = models.find(option => key({ provider: option.provider, model: option.id }) === value);
      const selection = m ? { provider: m.provider, model: m.id, effort: m.efforts.includes('low') ? 'low' : m.defaultEffort, label: m.label } : null;
      if (all) setDefaultCallModel(selection); else setChatCallModel(bot.id, selection);
    };
    const fallback = defaultCallModel();
    return <div className="panel-card">
      {!availability?.localSpeech && <div className="panel-row">Set up a speech provider in Settings → Audio.</div>}
      {availability?.localSpeech && <>
        <div className="panel-row panel-row--setting">
          <span>Call model</span>
          <NativeSelect label="Call model for this chat" value={chosen ? key(chosen) : ''} options={chosen && !modelOptions.some(o => o.value === key(chosen)) ? [...modelOptions, { value: key(chosen), label: chosen.label ?? chosen.model }] : modelOptions} onChange={(value) => pick(value, false)} />
        </div>
        <div className="panel-row panel-row--setting">
          <span>Default for all chats</span>
          <NativeSelect label="Default call model" value={fallback ? key(fallback) : ''} options={[{ value: '', label: 'Each chat’s model' }, ...modelOptions.slice(1)]} onChange={(value) => pick(value, true)} />
        </div>
        <div className="panel-row panel-row--setting">
          <span>Speed</span>
          <NativeSelect label="Speed" value={bot.voiceSpeed} options={opts.speeds.map((v) => ({ value: v, label: speedLabel(v) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
        </div>
      </>}
      {availability?.realtime && availability.localSpeech && !localCall && <button type="button" className="panel-row panel-row--action" onClick={() => inCall ? endCall() : startCall(bot.id)}>
        {inCall ? 'End Grok realtime call' : 'Start Grok realtime call'}
      </button>}
      {availability?.localSpeech && !inCall && <button type="button" className={`panel-row panel-row--action panel-row--call${localCall ? ' is-active' : ''}`} onClick={() => localCall ? endLocalCall() : startLocalCall(bot)}>
        {localCall ? <PhoneOff size={14} /> : <Phone size={14} />} {localCall ? 'End call' : `Call ${bot.name}`}
      </button>}
      {error && <div className="voice-error">{error}</div>}
    </div>;
  }
  const voices = opts.voices.some((v) => v.id === bot.voice) ? opts.voices : [{ id: bot.voice, name: bot.voice }, ...opts.voices];
  const speeds = opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>Voice</span>
        <span className="voice-setting__right">
          <button type="button" className="voice-preview" onClick={preview} disabled={previewing} title={`Hear ${bot.name}'s voice`}>{previewing ? 'Playing…' : 'Preview'}</button>
          <NativeSelect label="Voice" value={bot.voice} options={voices.map((v) => ({ value: v.id, label: v.name }))} onChange={(voice) => save({ voice })} />
        </span>
      </div>
      <div className="panel-row panel-row--setting">
        <span>Speed</span>
        <NativeSelect label="Speed" value={bot.voiceSpeed} options={speeds.map((s) => ({ value: s, label: speedLabel(s) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
      </div>
      <div className="panel-row panel-row--setting">
        <span>Language</span>
        <NativeSelect label="Language" value={bot.voiceLanguage} options={opts.languages.map((l) => ({ value: l.code, label: l.name }))} onChange={(voiceLanguage) => save({ voiceLanguage })} />
      </div>
      <button type="button" className={`panel-row panel-row--action panel-row--call${inCall ? ' is-active' : ''}`} onClick={() => (inCall ? endCall() : startCall(bot.id))}>
        {inCall ? <PhoneOff size={14} /> : <Phone size={14} />} {inCall ? 'End call' : `Call ${bot.name}`}
      </button>
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}
