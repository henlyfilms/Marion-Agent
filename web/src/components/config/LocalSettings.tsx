import { useCallback, useEffect, useState } from 'react';
import type { ChatModelSelection, ChatProvider } from '@shared/types';
import { configApi, type ChatProviderSettings, type ComposioStatus, type LocalModels, type SubscriptionModelSettings } from '../../lib/configApi';
import { LocalMemory } from '../LocalMemory';
import { useStore } from '../../store';
import { listMicrophones, microphoneId, micErrorMessage, openMic, setMicrophoneId } from '../../voice/audio';
import { playDictationSound, setSoundsEnabled, soundsEnabled } from '../../voice/sounds';
import { voiceApi } from '../../voice/api';

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
      <p className="cfg-field__hint">Bots without a model override use these chat defaults.</p>
      {data?.provider && data.provider !== 'local' && <SubscriptionModel key={data.provider} provider={data.provider} />}
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

function SubscriptionModel({ provider }: { provider: Exclude<ChatProvider, 'local'> }) {
  const [data, setData] = useState<SubscriptionModelSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    configApi.subscriptionModel(provider).then(result => { if (active) setData(result); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [provider]);
  const save = async (selection: ChatModelSelection) => {
    setBusy(true);
    setError('');
    try { setData(await configApi.selectSubscriptionModel(selection)); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const active = data?.models.find(model => model.id === data.selection.model);
  return (
    <>
      <div className="local-settings__controls">
        <label htmlFor="default-chat-model">Default chat model</label>
        <select id="default-chat-model" className="text-input" disabled={busy || !data?.models.length}
          value={data?.selection.model ?? ''} onChange={event => {
            const model = data?.models.find(option => option.id === event.target.value);
            if (model) void save({ provider, model: model.id, effort: model.defaultEffort });
          }}>
          {!active && <option value={data?.selection.model ?? ''}>{data?.selection.model || (data ? 'Choose a model' : 'Checking models…')}</option>}
          {data?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </div>
      {!!active?.efforts.length && data && <div className="local-settings__controls">
        <label htmlFor="default-chat-effort">Default reasoning effort</label>
        <select id="default-chat-effort" className="text-input" disabled={busy} value={data.selection.effort ?? ''}
          onChange={event => void save({ ...data.selection, effort: event.target.value })}>
          {active.efforts.map(effort => <option key={effort} value={effort}>{effort[0].toUpperCase() + effort.slice(1)}</option>)}
        </select>
      </div>}
      {(error || data?.error) && <p className="cfg-error" role="alert">{error || data?.error}</p>}
    </>
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
    </section>
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
