import { useCallback, useEffect, useState } from 'react';
import { configApi, type ComposioStatus, type LocalModels } from '../../lib/configApi';
import { useStore } from '../../store';
import { microphoneId, micErrorMessage, openMic, setMicrophoneId } from '../../voice/audio';
import { voiceApi } from '../../voice/api';

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
      <label htmlFor="local-model" className="cfg-section__label">Local model</label>
      <div className="local-settings__controls">
        <select id="local-model" className="text-input" disabled={busy || !data} value={data?.selected ?? ''} onChange={event => void save(event.target.value === data?.defaultModel ? '' : event.target.value)}>
          {!data && <option value="">Checking models…</option>}
          {data && <option value={data.defaultModel}>{data.defaultModel} (server default)</option>}
          {models.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={refresh}>Refresh models</button>
      </div>
      {data && !data.reachable && <p className="cfg-field__hint" role="status">Start Ollama or your configured model server on this computer, then refresh.</p>}
      {error && <p className="cfg-error" role="alert">{error}</p>}
    </section>
  );
}

export function AudioSettings() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [choice, setChoice] = useState(microphoneId);
  const [status, setStatus] = useState('');
  const [availability, setAvailability] = useState<Awaited<ReturnType<typeof voiceApi.status>>>();
  const list = useCallback(async () => {
    const devices = await navigator.mediaDevices?.enumerateDevices();
    setInputs(devices?.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default') ?? []);
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
        {availability.localSpeech ? 'Local dictation and push-to-talk are enabled.' : availability.realtime ? 'xAI dictation and realtime voice are enabled.' : 'Set MARION_STT_URL for local speech or XAI_API_KEY for hosted voice.'}
      </p>}
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
