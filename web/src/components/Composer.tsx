import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Activity, FileText, Mic, Paperclip, SquareSlash, X } from 'lucide-react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { ModelPicker } from './ModelPicker';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { voiceApi, type VoiceStatus } from '../voice/api';
import { playDictationSound } from '../voice/sounds';
import { useDictation } from '../voice/dictation';
import { appendDictation, supportsLiveDictation, useLiveDictation } from '../voice/liveDictation';
import { listMicrophones, microphoneId, micErrorMessage, openMic, setMicrophoneId } from '../voice/audio';
import { dictationShortcut, shortcutFor } from '../voice/shortcut';
import { useConfigUI } from '../configStore';
import { useCompactLayout } from '../lib/layout';

const MAX_H = 200;
const drafts = new Map<string, string>();
const fileDrafts = new Map<string, File[]>();
const photoTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const textFiles = '.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.html,.htm,.css,.js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx,.py,.sh,.sql';
const isPhoto = (file: File) => photoTypes.includes(file.type) || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name);

function DraftAttachment({ file, remove, disabled }: { file: File; remove: () => void; disabled: boolean }) {
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!isPhoto(file)) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <li className="composer-file">
      {preview ? <img src={preview} alt="" /> : <FileText size={17} aria-hidden="true" />}
      <span title={file.name}>{file.name}</span>
      <button type="button" onClick={remove} disabled={disabled} aria-label={`Remove ${file.name}`}><X size={15} /></button>
    </li>
  );
}

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const inputId = useId();
  const savingModel = useStore(s => !!s.savingChatModels[bot.id]);
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<'attachments' | 'commands' | null>(null);
  const [files, setFiles] = useState(() => fileDrafts.get(bot.id) ?? []);
  const fileInput = useRef<HTMLInputElement>(null);
  const plusButton = useRef<HTMLButtonElement>(null);
  const [audioMenu, setAudioMenu] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState(microphoneId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const micPress = useRef<{ id: number; at: number; started: boolean }>();
  const selection = useRef<{ start: number; end: number }>();
  const setModal = useStore((s) => s.setModal);
  const localCall = useStore(s => s.localVoiceBotId === bot.id);
  const mobileChatOpen = useStore(s => s.mobileChatOpen);
  const compact = useCompactLayout();
  useEffect(() => { voiceApi.status().then(setVoiceStatus).catch(() => {}); }, []);
  const openCall = () => {
    if (voiceStatus?.localSpeech) useStore.setState({ localVoiceBotId: bot.id });
    else if (voiceStatus?.realtime) startCall(bot.id);
    else setError('Set up a speech provider in Settings → Audio.');
  };

  // Per-bot drafts.
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);
  useEffect(() => {
    if (files.length) fileDrafts.set(bot.id, files);
    else fileDrafts.delete(bot.id);
  }, [bot.id, files]);
  useEffect(() => { if (!compact) ref.current?.focus(); }, [compact]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = shown.trim();
    if ((!t && !files.length) || sending || savingModel) return;
    const command = commands.find(item => item.label === t);
    if (command && !files.length) { runCommand(command); return; }
    discardDictation();
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t, files);
      setFiles([]);
      fileDrafts.delete(bot.id);
      setText('');
      drafts.delete(bot.id);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      if (!compact) ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const chooseFiles = () => fileInput.current?.click();
  const addFiles = (added: File[]) => {
    const combined = [...files, ...added];
    if (combined.length > 4) { setError('Add up to four attachments per message.'); return; }
    const invalid = added.find(file => !file.size || file.size > (isPhoto(file) ? 4 * 1024 * 1024 : 32 * 1024));
    if (invalid) {
      setError(!invalid.size ? 'Choose a file with content.' : isPhoto(invalid) ? 'Photos must be 4 MB or smaller.' : 'Text files must be 32 KB or smaller.');
      return;
    }
    setFiles(combined);
    setError(null);
  };

  // Server transcription preserves the selection the user had when recording started.
  const insertText = (t: string) => {
    const el = ref.current;
    const range = selection.current;
    selection.current = undefined;
    setText((cur) => {
      const start = range?.start ?? cur.length;
      const end = range?.end ?? cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el && document.activeElement === el) { const pos = before.length + pre.length + t.length; el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const recorded = useDictation(insertText, setError, bot.voiceLanguage, 10 * 60_000, voiceStatus?.nativeSpeech);
  const spoken = useLiveDictation(words => setText(current => appendDictation(current, words)), setError, bot.voiceLanguage);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);
  const state = spoken.state !== 'idle' ? spoken.state : recorded.state;
  const shown = spoken.interim ? appendDictation(text, spoken.interim) : text;
  const discardDictation = () => { spoken.stop(true); recorded.finish(true); };
  const stopDictation = () => {
    if (spoken.state === 'recording') playDictationSound(false);
    spoken.stop(); recorded.finish();
  };
  const startDictation = () => {
    if (inCall || localCall) { setError('End the voice call before starting dictation.'); return; }
    setError(null);
    setAudioMenu(false);
    const audioInput = microphoneId();
    const server = voiceStatus?.localSpeech || voiceStatus?.realtime;
    const preferServer = voiceStatus?.localSpeech || (server && (audioInput || /Electron\//.test(navigator.userAgent)));
    if (!preferServer && !/Electron\//.test(navigator.userAgent) && supportsLiveDictation(audioInput)) {
      playDictationSound(true);
      void spoken.start(audioInput);
      return;
    }
    if (server) {
      const input = ref.current;
      selection.current = input && document.activeElement === input ? { start: input.selectionStart, end: input.selectionEnd } : undefined;
      void recorded.begin();
      return;
    }
    setError(audioInput
      ? 'This browser needs a speech server for the selected input. Choose System default or set up speech in Settings → Audio.'
      : 'Set up a speech provider in Settings → Audio.');
  };
  const toggleDictation = () => {
    if (state === 'recording') stopDictation();
    else if (state === 'idle') startDictation();
  };
  useEffect(() => {
    if (compact && !mobileChatOpen) { spoken.stop(true); recorded.finish(true); }
  }, [compact, mobileChatOpen, spoken.stop, recorded.finish]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state !== 'idle') { discardDictation(); return; }
      if (event.defaultPrevented || event.isComposing || event.repeat || shortcutFor(event) !== dictationShortcut()) return;
      const ui = useConfigUI.getState();
      if (ui.appSettings || ui.botSettings || ui.view !== 'chat' || useStore.getState().modal || (compact && !mobileChatOpen)) return;
      if (event.target instanceof HTMLElement && event.target !== ref.current
        && event.target.closest('textarea, input, [contenteditable="true"]')) return;
      event.preventDefault();
      toggleDictation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [shown, mobileChatOpen]);

  const showInputs = (requestAccess = false) => {
    setMenu(null);
    setAudioMenu(true);
    setSelectedInput(microphoneId());
    const list = async () => {
      if (requestAccess) {
        const stream = await openMic('');
        stream.getTracks().forEach(track => track.stop());
      }
      setInputs(await listMicrophones());
    };
    void list().catch(cause => setError(micErrorMessage(cause)));
  };
  const selectMic = (id: string) => {
    if (id !== microphoneId()) discardDictation();
    setMicrophoneId(id);
    setSelectedInput(id);
  };
  const pressMic = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.ctrlKey || state === 'transcribing') return;
    event.preventDefault();
    const started = state === 'idle';
    micPress.current = { id: event.pointerId, at: Date.now(), started };
    event.currentTarget.setPointerCapture(event.pointerId);
    toggleDictation();
  };
  const releaseMic = (event: PointerEvent<HTMLButtonElement>) => {
    const press = micPress.current;
    micPress.current = undefined;
    if (press?.id === event.pointerId && press.started && Date.now() - press.at >= 350) stopDictation();
  };

  const commands = [
    { label: '/attach', detail: 'Add files or photos', icon: <Paperclip size={15} />, onSelect: chooseFiles },
    { label: '/usage', detail: 'View subscription limits', icon: <Activity size={15} />, onSelect: () => setModal('usage') },
    { label: '/dictate', detail: 'Toggle dictation', icon: <Mic size={15} />, onSelect: toggleDictation },
  ];
  const runCommand = (command: typeof commands[number]) => {
    if (shown.trim() === command.label) { discardDictation(); setText(''); }
    if (command.label === '/usage') plusButton.current?.focus();
    else ref.current?.focus();
    command.onSelect();
  };
  const hasMessage = shown.trim().length > 0 || files.length > 0;
  const multiline = shown.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div className="composer-area">
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className="composer__progress" role="status" data-visible={sending || state !== 'idle'}>
        <span className="loading-dot" aria-hidden="true" />{sending ? 'Sending…' : state === 'recording' ? 'Listening…' : state === 'transcribing' ? 'Transcribing…' : ''}
      </div>
      <div className="composer__models">
        <ModelPicker bot={bot} inputId={inputId} />
      </div>
      {files.length > 0 && <ul className="composer-files" aria-label="Draft attachments">
        {files.map((file, index) => <DraftAttachment key={`${file.name}:${file.lastModified}:${index}`} file={file} disabled={sending}
          remove={() => setFiles(current => current.filter((_, position) => position !== index))} />)}
      </ul>}
      <div className={`composer${multiline ? ' is-multiline' : ''}`}>
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <input ref={fileInput} type="file" multiple hidden accept={[...photoTypes, textFiles].join(',')} onChange={event => {
              addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
              ref.current?.focus();
            }} />
            <button ref={plusButton} type="button" className="composer__btn" onClick={() => setMenu(menu ? null : 'attachments')}
              disabled={sending} aria-label="Add attachments or commands" title="Add attachments or commands" aria-haspopup="menu" aria-expanded={!!menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                label={menu === 'commands' ? 'Slash commands' : 'Composer actions'}
                className="composer-menu"
                onClose={() => setMenu(null)}
                items={menu === 'commands' ? commands.map(command => ({ ...command, onSelect: () => runCommand(command) })) : [
                  { label: 'Add files or photos', icon: <Paperclip size={16} />, onSelect: chooseFiles },
                  { label: 'Slash commands', icon: <SquareSlash size={16} />, onSelect: () => setMenu('commands') },
                ]}
              />
            )}
          </span>
          <textarea data-dictation-composer
            id={inputId}
            ref={ref}
            className="composer__input"
            rows={1}
            value={shown}
            placeholder={`Message ${displayName(bot)}`}
            onChange={(e) => { discardDictation(); setText(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-label={`Message ${bot.name}`}
          />
        </div>
        <div className="composer__right">
          <span className="composer__mic-anchor"><button
            type="button"
            className={`composer__btn${state === 'recording' ? ' is-recording' : state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={state === 'recording'} aria-keyshortcuts={dictationShortcut()}
            title={state === 'recording' ? 'Tap to stop · Esc cancels' : `Dictate (${dictationShortcut()}) · Right-click for audio input`}
            disabled={state === 'transcribing'}
            onPointerDown={pressMic}
            onPointerUp={releaseMic}
            onClick={event => { if (event.detail === 0) toggleDictation(); }}
            onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showInputs(); } }}
            onPointerCancel={() => { if (micPress.current?.started) discardDictation(); micPress.current = undefined; }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showInputs(); }}
          >
            <Icon name="mic" opacity={0.56} />
          </button>
          {audioMenu && <Menu label="Audio input" placement="above" align="right" className="microphone-menu" onClose={() => setAudioMenu(false)} items={[
            { label: 'System default', checked: selectedInput === '', onSelect: () => selectMic('') },
            ...inputs.map((device, index) => ({ label: device.label || `Microphone ${index + 1}`, checked: selectedInput === device.deviceId, onSelect: () => selectMic(device.deviceId) })),
            { label: 'Refresh microphone list', separator: true, onSelect: () => showInputs(true) },
          ]}><div className="menu__header">Audio input</div></Menu>}
          </span>
          {(inCall || localCall) && !hasMessage ? (
            <button type="button" className="composer__cta is-in-call" onClick={() => localCall ? useStore.setState({ localVoiceBotId: null }) : endCall()} aria-label="End voice call" title="End voice call">
              <Icon name="voice_a" size={16} />
            </button>
          ) : running && !hasMessage ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={hasMessage ? send : openCall}
              disabled={hasMessage && (sending || savingModel)}
              aria-label={hasMessage ? 'Send' : `Start voice chat with ${bot.name}`}
              title={hasMessage ? 'Send (Enter)' : 'Start voice chat'}
            >
              <Icon name={hasMessage ? 'arrow_up' : 'voice_a'} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
