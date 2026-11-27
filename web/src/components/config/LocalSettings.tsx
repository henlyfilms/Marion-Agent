import { useCallback, useEffect, useState } from 'react';
import type { ChatModelSelection, ChatProvider } from '@shared/types';
import { configApi, type ChatProviderSettings, type ComposioStatus, type LocalModels, type SubscriptionModelSettings } from '../../lib/configApi';
import { LocalMemory } from '../LocalMemory';
import { useStore } from '../../store';
import { listMicrophones, microphoneId, micErrorMessage, openMic, setMicrophoneId } from '../../voice/audio';
import { playDictationSound, setSoundsEnabled, soundsEnabled } from '../../voice/sounds';
import { addCallVoice, callVoices, removeCallVoice, voiceApi, type CallVoices } from '../../voice/api';

export function SubscriptionSettings() {
  const [data, setData] = useState<ChatProviderSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = async (provider?: ChatProvider) => {
    setBusy(true);
    setError('');
    try { setData(await (provider ? configApi.selectChatProvider(provider) : configApi.chatProvider())); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let mounted = true;
    configApi.chatProvider().then(result => { if (mounted) setData(result); })
      .catch(error => { if (mounted) setError(error.message); });
    return () => { mounted = false; };
  }, []);
  return (
    <section className="cfg-section">
      <label htmlFor="chat-provider" className="cfg-section__label">Default chat provider</label>
      <div className="local-settings__controls">
        <select id="chat-provider" className="text-input" value={data?.provider ?? 'local'} disabled={!data || busy} onChange={event => void update(event.target.value as ChatProvider)}>
          <option value="local">Local model</option>
          <option value="codex" disabled={!data?.installed.codex}>Codex · ChatGPT plan</option>
          <option value="gemini" disabled={!data?.installed.gemini}>Gemini · Google AI plan</option>
          <option value="claude" disabled={!data?.installed.claude}>Claude Code · Claude plan</option>
        </select>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void update()}>Refresh providers</button>
      </div>
      <p className="cfg-field__hint">Bots without a model override use this provider with its default model and effort below.</p>
      {data?.provider === 'codex' && <p className="cfg-field__hint">Run <code>codex login</code> in Terminal and choose your ChatGPT account.</p>}
      {data?.provider === 'gemini' && <p className="cfg-field__hint">Run <code>agy acp --login</code> in Terminal and choose your personal Google account. If Terminal cannot find it, use <code>~/.local/bin/agy acp --login</code>.</p>}
      {data && !data.installed.codex && <p className="cfg-field__hint"><a href="https://learn.chatgpt.com/docs/codex-cli" target="_blank" rel="noreferrer">Install Codex CLI</a></p>}
      {data && !data.installed.gemini && <p className="cfg-field__hint"><a href="https://antigravity.google/docs/cli/getting-started" target="_blank" rel="noreferrer">Install Google Antigravity CLI</a></p>}
      {data?.provider === 'claude' && <p className="cfg-field__hint">Sign in to Claude Code in Terminal with <code>claude auth login --claudeai</code>.</p>}
      {data && !data.installed.claude && <p className="cfg-field__hint"><a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">Install Claude Code</a></p>}
      {error && <p className="cfg-error" role="alert">{error}</p>}
    </section>
  );
}

type BuilderProvider = Exclude<ChatProvider, 'local'>;
const BUILDER_PROVIDERS: Array<{ provider: BuilderProvider; name: string }> = [
  { provider: 'claude', name: 'Claude' }, { provider: 'codex', name: 'Codex' }, { provider: 'gemini', name: 'Gemini' },
];
const effortLabel = (effort: string) => effort[0].toUpperCase() + effort.slice(1);

/**
 * Default model and effort for each coding/builder provider. Chat, ask, team (orchestrate) and builder runs use these
 * whenever a request does not name a model or effort itself.
 */
export function ProviderDefaultsSettings() {
  const [installed, setInstalled] = useState<ChatProviderSettings['installed']>();
  useEffect(() => {
    let mounted = true;
    configApi.chatProvider().then(result => { if (mounted) setInstalled(result.installed); }).catch(() => { if (mounted) setInstalled(undefined); });
    return () => { mounted = false; };
  }, []);
  return (
    <section className="cfg-section" aria-labelledby="provider-defaults-label">
      <span id="provider-defaults-label" className="cfg-section__label">Default model &amp; effort</span>
      <p className="cfg-field__hint">Used for chat, builder, team and Ask runs whenever a request doesn’t name a model or effort.</p>
      <div className="provider-defaults">
        {BUILDER_PROVIDERS.map(({ provider, name }) => (
          <ProviderDefaultRow key={provider} provider={provider} name={name} installed={installed?.[provider]} />
        ))}
      </div>
    </section>
  );
}

function ProviderDefaultRow({ provider, name, installed }: { provider: BuilderProvider; name: string; installed?: boolean }) {
  const [data, setData] = useState<SubscriptionModelSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!installed) return;
    let active = true;
    configApi.subscriptionModel(provider).then(result => { if (active) setData(result); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [provider, installed]);
  const save = async (selection: ChatModelSelection) => {
    setBusy(true);
    setError('');
    try { setData(await configApi.selectSubscriptionModel(selection)); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const active = data?.models.find(model => model.id === data.selection.model);
  const modelId = `default-model-${provider}`;
  const effortId = `default-effort-${provider}`;
  return (
    <div className="provider-defaults__row">
      <span className="provider-defaults__name">{name}</span>
      {installed === false ? <span className="provider-defaults__missing">Not installed</span> : <>
        <select id={modelId} aria-label={`${name} default model`} className="text-input" disabled={busy || !data?.models.length}
          value={data?.selection.model ?? ''} onChange={event => {
            const model = data?.models.find(option => option.id === event.target.value);
            // Keep the chosen effort when the new model offers it.
            const effort = model && data?.selection.effort && model.efforts.includes(data.selection.effort) ? data.selection.effort : model?.defaultEffort ?? null;
            if (model) void save({ provider, model: model.id, effort });
          }}>
          {!active && <option value={data?.selection.model ?? ''}>{data?.selection.model || (data || installed === undefined ? 'Checking models…' : 'Choose a model')}</option>}
          {data?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
        <select id={effortId} aria-label={`${name} default effort`} className="text-input provider-defaults__effort"
          disabled={busy || !active?.efforts.length} value={data?.selection.effort ?? ''}
          onChange={event => data && void save({ ...data.selection, provider, effort: event.target.value })}>
          {!active?.efforts.length && <option value="">{active ? 'No effort' : '—'}</option>}
          {active?.efforts.map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
        </select>
      </>}
      {(error || data?.error) && <p className="cfg-error provider-defaults__error" role="alert">{error || data?.error}</p>}
    </div>
  );
}

export function LocalModelSettings() {
  const [data, setData] = useState<LocalModels>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try { setData(await configApi.models()); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (model: string) => {
    setBusy(true); setError('');
    try {
      const { selected } = await configApi.selectModel(model);
      setData(value => value && { ...value, selected });
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const models = data?.models.filter(model => model !== data.defaultModel) ?? [];
  if (data && data.selected !== data.defaultModel && !models.includes(data.selected)) models.push(data.selected);
  return (
    <section className="cfg-section">
      <label htmlFor="local-model" className="cfg-section__label">Default local model</label>
      <div className="local-settings__controls">
        <select id="local-model" className="text-input" disabled={busy || !data} value={data?.selected ?? ''} onChange={event => void save(event.target.value === data?.defaultModel ? '' : event.target.value)}>
          {!data && <option value="">Checking models…</option>}
          {data && <option value={data.defaultModel}>{data.defaultModel} (server default)</option>}
          {models.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={refresh}>Refresh models</button>
      </div>
      <LocalMemory />
      {data && !data.reachable && <p className="cfg-field__hint" role="status">Start Ollama or your configured model server on this computer, then refresh.</p>}
      {error && <p className="cfg-error" role="alert">{error}</p>}
    </section>
  );
}

export function AudioSettings() {
  const [sound, setSound] = useState(soundsEnabled);
  const [testingVoice, setTestingVoice] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [choice, setChoice] = useState(microphoneId);
  const [status, setStatus] = useState('');
  const [availability, setAvailability] = useState<Awaited<ReturnType<typeof voiceApi.status>>>();
  const list = useCallback(async () => {
    setInputs(await listMicrophones());
  }, []);
  useEffect(() => {
    const refresh = () => void list().catch(error => setStatus(micErrorMessage(error)));
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    voiceApi.status().then(setAvailability).catch(() => {});
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [list]);
  const test = async () => {
    setStatus('Opening microphone…');
    try {
      const mic = await openMic(choice);
      const name = mic.getAudioTracks()[0]?.label || 'Microphone';
      mic.getTracks().forEach(track => track.stop());
      await list();
      setStatus(`${name} is available.`);
    } catch (error) { setStatus(micErrorMessage(error)); }
  };

  const testVoice = async () => {
    setTestingVoice(true);
    setStatus('');
    let url: string | undefined;
    try {
      const blob = await voiceApi.speech(undefined, 'Hello from Marion Agent. Your voice provider is ready.', 1, AbortSignal.timeout(15_000));
      url = URL.createObjectURL(blob);
      const player = new Audio(url);
      await player.play();
      await new Promise<void>((resolve, reject) => {
        player.onended = () => resolve();
        player.onerror = () => reject(new Error('Could not play the Mac voice.'));
      });
    } catch (error) { setStatus((error as Error).message); }
    finally {
      if (url) URL.revokeObjectURL(url);
      setTestingVoice(false);
    }
  };
  return (
    <section className="cfg-section">
      <label htmlFor="audio-input" className="cfg-section__label">Microphone input</label>
      <div className="local-settings__controls">
        <select id="audio-input" className="text-input" value={choice} onChange={event => {
          setChoice(event.target.value); setMicrophoneId(event.target.value); setStatus('');
        }}>
          <option value="">System default</option>
          {choice && !inputs.some(device => device.deviceId === choice) && <option value={choice}>Previously selected microphone</option>}
          {inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
        </select>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={test}>Test microphone</button>
      </div>
      <p className="cfg-field__hint" role="status">{status || (inputs.some(device => device.label) ? 'Used for dictation and voice calls.' : 'Grant microphone permission to see device names.')}</p>
      {availability && <p className="cfg-field__hint">
        {availability.nativeSpeech ? 'Speech provider: On-device macOS dictation and voice playback.' : availability.localSpeech ? 'Local dictation and push-to-talk are enabled.' : availability.realtime ? 'xAI dictation and realtime voice are enabled.' : 'Set MARION_STT_URL for local speech or XAI_API_KEY for hosted voice.'}
      </p>}
      {availability?.nativePlayback && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={testingVoice} onClick={() => void testVoice()}>{testingVoice ? 'Playing…' : 'Test voice playback'}</button>}
      <label className="local-settings__controls">
        <input type="checkbox" checked={sound} onChange={event => {
          const enabled = event.target.checked;
          setSound(enabled);
          setSoundsEnabled(enabled);
          if (enabled) playDictationSound(true);
        }} />
        Enable interface sounds
      </label>
      {availability?.nativePlayback && <VoicesManager />}
    </section>
  );
}

/** Your own call voices: a voice file (for voice-cloning servers) and/or a speech model server address. */
function VoicesManager() {
  const [voices, setVoices] = useState<CallVoices['custom']>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = () => callVoices().then(r => setVoices(r.custom)).catch(() => {});
  useEffect(() => { void load(); }, []);
  const changed = () => { void load(); window.dispatchEvent(new Event('marion-agent:voices-changed')); };
  const add = async () => {
    setBusy(true); setMessage('');
    const form = new FormData();
    form.append('name', name); form.append('url', url); form.append('model', model); form.append('voice', voiceName);
    if (file) form.append('sample', file);
    try {
      await addCallVoice(form);
      setAdding(false); setName(''); setUrl(''); setModel(''); setVoiceName(''); setFile(null);
      setMessage('Voice added. Pick it in any chat’s side panel under Voice chat.');
      changed();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="voices-manager">
      <div className="cfg-section__label">Call voices</div>
      <p className="cfg-field__hint">Every voice installed on this Mac is in each chat’s Voice menu. Add more in System Settings → Accessibility → Spoken Content, or add your own here.</p>
      <div className="cfg-card">
        {voices.map(voice => (
          <div key={voice.id} className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{voice.name}</div>
              <div className="cfg-row__sub">{[voice.url && `Model server ${voice.model ? `· ${voice.model}` : ''}`, voice.sampleName && `Voice file · ${voice.sampleName}`].filter(Boolean).join(' · ') || 'Voice'}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--ghost-danger" onClick={() => removeCallVoice(voice.id).then(changed).catch(error => setMessage((error as Error).message))}>Remove</button>
          </div>
        ))}
        {!adding && <div className="cfg-row"><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAdding(true)}>Add a voice…</button></div>}
        {adding && (
          <form className="voices-manager__form" onSubmit={event => { event.preventDefault(); void add(); }}>
            <input className="text-input" placeholder="Name, e.g. My voice" value={name} onChange={event => setName(event.target.value)} aria-label="Voice name" autoFocus />
            <label className="voices-manager__file">
              <input type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg" onChange={event => setFile(event.target.files?.[0] ?? null)} />
              <span>{file ? file.name : 'Voice file (optional): a 10–30 second clip of the voice'}</span>
            </label>
            <input className="text-input" placeholder="Speech server, e.g. http://127.0.0.1:8880/v1/audio/speech" value={url} onChange={event => setUrl(event.target.value)} aria-label="Speech model server address" />
            <div className="voices-manager__pair">
              <input className="text-input" placeholder="Model (optional)" value={model} onChange={event => setModel(event.target.value)} aria-label="Model" />
              <input className="text-input" placeholder="Voice name on the server (optional)" value={voiceName} onChange={event => setVoiceName(event.target.value)} aria-label="Voice on the server" />
            </div>
            <p className="cfg-field__hint">A voice file needs a voice-cloning model to speak (for example F5-TTS or Chatterbox running on this Mac): put its address above. Any OpenAI-style speech server works.</p>
            <div className="voices-manager__actions">
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAdding(false)}>Cancel</button>
              <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !name.trim() || (!file && !url.trim())}>{busy ? 'Adding…' : 'Add voice'}</button>
            </div>
          </form>
        )}
      </div>
      {message && <p className="cfg-field__hint" role="status">{message}</p>}
    </div>
  );
}

export function ComposioSettings({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = useState<ComposioStatus>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    configApi.composio().then(setStatus).catch(error => setMessage(error.message));
  }, []);
  const update = async (value: string) => {
    setBusy(true); setMessage('');
    try {
      const next = await configApi.saveComposioKey(value);
      setStatus(next); setKey('');
      setMessage(next.configured ? 'Project verified. You can now link apps.' : 'Local project key removed.');
      useStore.setState(state => ({ connectionsVersion: state.connectionsVersion + 1 }));
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Composio project</div>
      {status?.editable && (
        <form className="local-settings__controls" onSubmit={event => { event.preventDefault(); void update(key.trim()); }}>
          <input className="text-input" aria-label="Composio project API key" type="password" autoComplete="off" placeholder={status.configured ? 'Replace saved project key' : 'Project API key'} value={key} onChange={event => setKey(event.target.value)} />
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !key.trim()}>{busy ? 'Verifying…' : 'Verify and save'}</button>
        </form>
      )}
      <p className="cfg-field__hint">
        {status?.configured ? 'Composio is connected. Link each app through its own authorization screen.' : <>Get a project key from the <a href="https://platform.composio.dev/" target="_blank" rel="noreferrer">Composio dashboard</a>{status && !status.editable ? ' and set COMPOSIO_API_KEY on the server.' : '.'}</>}
      </p>
      {status?.configured && <div className="local-settings__controls">
        <button type="button" className="cfg-btn cfg-btn--primary" onClick={onReady}>Link an app</button>
        {status.editable && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void update('')}>Remove local key</button>}
      </div>}
      {message && <p className="cfg-field__hint" role="status">{message}</p>}
    </section>
  );
}
