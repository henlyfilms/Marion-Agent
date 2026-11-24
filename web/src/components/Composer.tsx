import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Activity, Clapperboard, FileText, Mic, Paperclip, Phone, PhoneOff, SquareSlash, Users, X } from 'lucide-react';
import { useFeatureUI } from '../lib/featuresApi';
import type { Bot, ChatModel } from '@shared/types';
import { configApi } from '../lib/configApi';
import { callModelFor, chatCallModel, defaultCallModel, endLocalCall, isLocalCallActive, setChatCallModel, setDefaultCallModel, startLocalCall, useLocalCall } from '../voice/localCall';
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
const isTextFile = (file: File) => file.type.startsWith('text/') || textFiles.split(',').some(ext => file.name.toLowerCase().endsWith(ext));
const MAX_PHOTO = 4 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;
/** Pasted screenshots arrive as "image.png"; give them a readable, unique name. */
const named = (file: File, index: number) => file.name && file.name !== 'image.png' ? file
  : new File([file], `Pasted image ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(':', '.')}${index ? ` (${index + 1})` : ''}.${file.type.split('/')[1] || 'png'}`, { type: file.type });

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
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState(microphoneId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const micPress = useRef<{ id: number; at: number; started: boolean }>();
  const selection = useRef<{ start: number; end: number }>();
  const setModal = useStore((s) => s.setModal);
  const localCall = useLocalCall(s => s.botId === bot.id && isLocalCallActive(s));
  const ringing = useLocalCall(s => s.botId === bot.id && s.status === 'ringing');
  useLocalCall(s => s.status); // re-render when call model prefs change
  const [callMenu, setCallMenu] = useState(false);
  const [callModels, setCallModels] = useState<ChatModel[] | null>(null);
  const showCallMenu = () => {
    setCallMenu(true);
    configApi.chatModels(bot.id, true).then(result => setCallModels(result.models)).catch(() => setCallModels([]));
  };
  const mobileChatOpen = useStore(s => s.mobileChatOpen);
  const compact = useCompactLayout();
  useEffect(() => { voiceApi.status().then(setVoiceStatus).catch(() => {}); }, []);
  const openCall = () => {
    if (voiceStatus?.localSpeech) startLocalCall(bot);
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
    const unsupported = added.find(file => !isPhoto(file) && !isTextFile(file));
    if (unsupported) {
      setError(/\.pdf$/i.test(unsupported.name)
        ? 'PDFs can’t be read yet. Copy the text into a .txt file, or take a screenshot of the page.'
        : `${unsupported.name} isn’t supported. Add photos (PNG, JPEG, WebP, GIF) or text files.`);
      return;
    }
    const invalid = added.find(file => !file.size || file.size > (isPhoto(file) ? MAX_PHOTO : MAX_TEXT));
    if (invalid) {
      setError(!invalid.size ? 'Choose a file with content.' : isPhoto(invalid) ? 'Photos must be 4 MB or smaller.' : 'Text files must be 256 KB or smaller.');
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
      // Match the live preview: a dictation that starts the message starts with a capital letter.
      if (!before.trim()) t = t.charAt(0).toUpperCase() + t.slice(1);
      requestAnimationFrame(() => { if (el && document.activeElement === el) { const pos = before.length + pre.length + t.length; el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const recorded = useDictation(insertText, setError, bot.voiceLanguage, 10 * 60_000, voiceStatus?.nativeSpeech);
  const spoken = useLiveDictation(words => setText(current => appendDictation(current, words)), setError, bot.voiceLanguage);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);
  const state = spoken.state !== 'idle' ? spoken.state : recorded.state;
  const liveWords = spoken.interim || recorded.interim;
  const shown = liveWords ? appendDictation(text, liveWords) : text;
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

  const [lines, setLines] = useState(1);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !el.clientWidth) return;
    el.style.height = '0px';
    const full = el.scrollHeight;
    el.style.height = `${Math.min(full, MAX_H)}px`;
    el.style.overflowY = full > MAX_H ? 'auto' : 'hidden';
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 20;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    setLines(Math.max(1, Math.round((full - padding) / line)));
  }, []);
  useLayoutEffect(fit, [shown, mobileChatOpen, fit]);
  // Re-measure when the composer is resized (window, panels, fonts) so an empty box never stays tall.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; fit(); } });
    observer.observe(el);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [fit]);

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
    { label: '/team', detail: 'Orchestrate several models together', icon: <Users size={15} />, onSelect: () => setModal('team') },
    { label: '/dictate', detail: 'Toggle dictation', icon: <Mic size={15} />, onSelect: toggleDictation },
    { label: '/teach', detail: 'Teach by screen recording', icon: <Clapperboard size={15} />, onSelect: () => useFeatureUI.getState().set({ teachBotId: bot.id }) },
  ];
  const runCommand = (command: typeof commands[number]) => {
    if (shown.trim() === command.label) { discardDictation(); setText(''); }
    if (command.label === '/usage') plusButton.current?.focus();
    else ref.current?.focus();
    command.onSelect();
  };
  const hasMessage = shown.trim().length > 0 || files.length > 0;
  const multiline = shown.includes('\n') || lines > 1;

  return (
    <div className={`composer-area${dropping ? ' is-dropping' : ''}`}
      onDragEnter={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); }}
      onDrop={event => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        addFiles(Array.from(event.dataTransfer.files));
        ref.current?.focus();
      }}>
      {dropping && <div className="composer-drop" aria-hidden="true">Drop photos or files to attach</div>}
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className="composer__progress" role="status" data-visible={sending || state !== 'idle'}>
        <span className="loading-dot" aria-hidden="true" />{sending ? 'Sending…' : state === 'recording' ? 'Listening…' : state === 'transcribing' ? 'Transcribing…' : ''}
      </div>
      <div className="composer__models">
        <ModelPicker bot={bot} inputId={inputId} />
        {bot.kind !== 'room' && (
          <button type="button" className={`chat-model__trigger team-trigger${bot.orchestration?.enabled ? ' is-on' : ''}`} onClick={() => setModal('team')}
            title={bot.orchestration?.enabled ? `Team: ${bot.orchestration.members.map(member => member.label).join(', ')}` : 'Work as a team with other models'}
            aria-label={bot.orchestration?.enabled ? `Team mode on with ${bot.orchestration.members.length} members` : 'Set up Team mode'}>
            <Users size={14} aria-hidden="true" />
            <span>{bot.orchestration?.enabled ? `Team · ${bot.orchestration.members.length}` : 'Team'}</span>
          </button>
        )}
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
                  ...(bot.kind === 'room' ? [] : [{ label: 'Teach by screen recording', icon: <Clapperboard size={16} />, onSelect: () => useFeatureUI.getState().set({ teachBotId: bot.id }) }]),
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
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (!pasted.length) return;
              e.preventDefault();
              addFiles(pasted.map(named));
            }}
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
            <button type="button" className={`composer__cta is-in-call${ringing ? ' is-call-ringing' : ''}`} onClick={() => localCall ? endLocalCall() : endCall()} aria-label="End call" title="End call">
              <PhoneOff size={16} aria-hidden />
            </button>
          ) : running && !hasMessage ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <span className="composer__call-anchor">
              <button
                type="button"
                className="composer__cta"
                onClick={hasMessage ? send : openCall}
                onContextMenu={hasMessage ? undefined : event => { event.preventDefault(); event.stopPropagation(); showCallMenu(); }}
                onKeyDown={hasMessage ? undefined : event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showCallMenu(); } }}
                disabled={hasMessage && (sending || savingModel)}
                aria-label={hasMessage ? 'Send' : `Call ${bot.name}`}
                title={hasMessage ? 'Send (Enter)' : `Call ${bot.name} · Right-click to choose the call model`}
              >
                {hasMessage ? <Icon name="arrow_up" size={16} /> : <Phone size={16} aria-hidden />}
              </button>
              {callMenu && <Menu label="Call model" placement="above" align="right" className="chat-model__menu" onClose={() => setCallMenu(false)} items={[
                { label: `Same as chat · ${bot.chatModel?.label ?? bot.chatModel?.model ?? 'chat model'}`, checked: !callModelFor(bot.id), onSelect: () => setChatCallModel(bot.id, null) },
                ...(callModels === null ? [{ label: 'Loading models…', disabled: true, onSelect: () => {} }] : callModels.map(model => {
                  const chosen = callModelFor(bot.id);
                  return {
                    group: ({ local: 'Local models', codex: 'Codex', gemini: 'Gemini', claude: 'Claude' } as const)[model.provider],
                    label: model.label, checked: chosen?.provider === model.provider && chosen.model === model.id,
                    onSelect: () => setChatCallModel(bot.id, { provider: model.provider, model: model.id, effort: model.defaultEffort ?? (model.provider === 'local' ? 'medium' : null), label: model.label }),
                  };
                })),
                ...(chatCallModel(bot.id) ? [{ label: 'Use this model for all chats’ calls', separator: true, onSelect: () => setDefaultCallModel(chatCallModel(bot.id)) }] : []),
                ...(defaultCallModel() ? [{ label: `Clear default (${defaultCallModel()!.label ?? defaultCallModel()!.model})`, separator: !chatCallModel(bot.id), onSelect: () => setDefaultCallModel(null) }] : []),
              ]}><div className="menu__header">Call model for this chat</div></Menu>}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
