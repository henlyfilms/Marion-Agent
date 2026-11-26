import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Activity, BarChart3, Brain, Eraser, FileText, Film, Images, Mic, MicOff, PanelRight, Paperclip, Phone, PhoneOff, Settings, Shrink, Sliders, Square, SquareSlash, Users, X } from 'lucide-react';
import { featuresApi, formatTokens, useFeatureUI } from '../lib/featuresApi';
import { MicSolid, PhoneSolid, ScreenRecordGlyph } from './SolidGlyphs';
import type { Bot, ChatModel } from '@shared/types';
import { configApi } from '../lib/configApi';
import { callModelFor, chatCallModel, defaultCallModel, endLocalCall, isLocalCallActive, setChatCallModel, setDefaultCallModel, startLocalCall, useLocalCall } from '../voice/localCall';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { ModelPicker } from './ModelPicker';
import { VoiceWave } from './VoiceWave';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { voiceApi, type VoiceStatus } from '../voice/api';
import { insertDictated, liveSpan, reconcileEdit, withSpan } from '../voice/dictationText';
import { composerDictation, registerDictationSink, useComposerDictation, type TextRange } from '../voice/composerDictation';
import { listMicrophones, microphoneId, micErrorMessage, openMic, setMicrophoneId } from '../voice/audio';
import { dictationShortcut, shortcutFor, shortcutLabel } from '../voice/shortcut';
import { useConfigUI } from '../configStore';
import { setDetailsOpen, useCompactLayout, useDetailsOpen } from '../lib/layout';
import { getDraft, onDraftChange, setDraft } from '../lib/drafts';
import { useMessageActions } from '../lib/messageActions';
import { ATTACH_EVENT, SCREENSHOT_SHORTCUT_LABEL } from '../lib/screenshots';

const MAX_H = 200;
const fileDrafts = new Map<string, File[]>();
const photoTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const textFiles = '.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.html,.htm,.css,.js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx,.py,.sh,.sql';
const isPhoto = (file: File) => photoTypes.includes(file.type) || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name);
const isTextFile = (file: File) => file.type.startsWith('text/') || textFiles.split(',').some(ext => file.name.toLowerCase().endsWith(ext));
const videoTypes = ['video/quicktime', 'video/mp4', 'video/webm'];
/** Screen recordings (macOS saves .mov); the server turns them into frames for Claude, Codex and Gemini. */
const isVideo = (file: File) => file.type.startsWith('video/') || /\.(?:mov|mp4|m4v|webm)$/i.test(file.name);
/** Matches the server: a few minutes of retina screen recording is far over 64 MB. */
const MAX_VIDEO = 256 * 1024 * 1024;
/** One message carries at most two recordings (the server's request size limit is two of them). */
const MAX_VIDEOS = 2;
const MAX_PHOTO = 4 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;
/** Pasted screenshots arrive as "image.png"; give them a readable, unique name. */
const named = (file: File, index: number) => {
  if (file.name && file.name !== 'image.png') return file;
  const recording = file.type.startsWith('video/');
  const extension = recording ? (file.type === 'video/quicktime' ? 'mov' : file.type.split('/')[1] || 'mp4') : file.type.split('/')[1] || 'png';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
  return new File([file], `Pasted ${recording ? 'recording' : 'image'} ${time}${index ? ` (${index + 1})` : ''}.${extension}`, { type: file.type });
};

const formatSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function DraftAttachment({ file, remove, disabled }: { file: File; remove: () => void; disabled: boolean }) {
  const [preview, setPreview] = useState<string>();
  const [seconds, setSeconds] = useState<number>();
  /** The browser can't decode this recording (e.g. an HEVC .mov): keep the chip, just without a thumbnail. */
  const [unplayable, setUnplayable] = useState(false);
  const video = isVideo(file);
  useEffect(() => {
    if (!isPhoto(file) && !video) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    setSeconds(undefined);
    setUnplayable(false);
    return () => URL.revokeObjectURL(url);
  }, [file, video]);
  const detail = [video && seconds ? formatDuration(seconds) : '', video ? formatSize(file.size) : ''].filter(Boolean).join(' · ');
  return (
    <li className={`composer-file${video ? ' is-video' : ''}`}>
      {video
        ? <span className="composer-file__thumb" aria-hidden="true">
            {preview && !unplayable
              ? <video src={`${preview}#t=0.1`} muted playsInline preload="metadata"
                  onLoadedMetadata={event => setSeconds(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : undefined)}
                  onError={() => setUnplayable(true)} />
              : <Film size={16} />}
          </span>
        : preview ? <img src={preview} alt="" /> : <FileText size={17} aria-hidden="true" />}
      <span className="composer-file__name" title={file.name}>
        {file.name}
        {detail && <small>{detail}</small>}
      </span>
      <button type="button" onClick={remove} disabled={disabled} aria-label={`Remove ${file.name}`}><X size={15} /></button>
    </li>
  );
}

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const inputId = useId();
  const reply = useMessageActions(s => s.replies[bot.id]);
  const savingModel = useStore(s => !!s.savingChatModels[bot.id]);
  const [text, renderText] = useState(() => getDraft(bot.id));
  // Persist immediately: a speech callback and a chat switch may batch into the same React commit.
  const setText = (next: string | ((current: string) => string)) => {
    const value = typeof next === 'function' ? next(getDraft(bot.id)) : next;
    setDraft(bot.id, value);
    renderText(value);
  };
  // A draft saved while this box was behind a settings sheet (late dictation) shows up as soon as it is written.
  useEffect(() => onDraftChange(id => { if (id === bot.id) renderText(getDraft(bot.id)); }), [bot.id]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Dictation problems show in a small pill above the mic instead of a full-width bar. */
  const [micError, setMicError] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState('');
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
  /** Where the live (still being heard) dictation words sit in the box right now. */
  const liveSpanShown = useRef({ at: 0, len: 0 });
  const micPress = useRef<{ id: number; at: number; started: boolean }>();
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
    composerDictation.discard();
    if (voiceStatus?.localSpeech) startLocalCall(bot);
    else if (voiceStatus?.realtime) startCall(bot.id);
    else setError('Set up a speech provider in Settings → Audio.');
  };

  // Per-bot drafts.
  useEffect(() => {
    if (files.length) fileDrafts.set(bot.id, files);
    else fileDrafts.delete(bot.id);
  }, [bot.id, files]);
  useEffect(() => { if (!compact) ref.current?.focus(); }, [compact]);
  // Choosing Reply puts the cursor straight into the box.
  const replySeq = reply?.seq;
  useEffect(() => { if (replySeq !== undefined) ref.current?.focus({ preventScroll: true }); }, [replySeq]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = shown.trim();
    if ((!t && !files.length) || sending || savingModel) return;
    const command = findCommand(t.toLowerCase());
    if (command && !files.length) { runCommand(command); return; }
    discardDictation();
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t, files, reply ? { replyTo: reply.seq } : {});
      useMessageActions.getState().setReply(bot.id, null);
      setFiles([]);
      fileDrafts.delete(bot.id);
      setText('');
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
    if (combined.length > 4) { setError('Add up to four attachments per message.'); return false; }
    if (combined.filter(isVideo).length > MAX_VIDEOS) { setError(`Add up to ${MAX_VIDEOS} screen recordings per message.`); return false; }
    const unsupported = added.find(file => !isPhoto(file) && !isVideo(file) && !isTextFile(file));
    if (unsupported) {
      setError(/\.pdf$/i.test(unsupported.name)
        ? 'PDFs can’t be read yet. Copy the text into a .txt file, or take a screenshot of the page.'
        : `${unsupported.name} isn’t supported. Add screenshots (PNG, JPEG, WebP, GIF), screen recordings (MOV, MP4, WebM) or text files.`);
      return false;
    }
    const limit = (file: File) => isVideo(file) ? MAX_VIDEO : isPhoto(file) ? MAX_PHOTO : MAX_TEXT;
    const invalid = added.find(file => !file.size || file.size > limit(file));
    if (invalid) {
      setError(!invalid.size ? 'Choose a file with content.' : isVideo(invalid) ? 'Screen recordings must be 256 MB or smaller.' : isPhoto(invalid) ? 'Photos must be 4 MB or smaller.' : 'Text files must be 256 KB or smaller.');
      return false;
    }
    setFiles(combined);
    setError(null);
    return true;
  };

  // The screenshot picker (⇧⌘S) hands its choice to the chat box that is open.
  const attach = useRef(addFiles);
  attach.current = addFiles;
  useLayoutEffect(() => {
    const onAttach = (event: Event) => {
      const detail = (event as CustomEvent<{ botId: string; files: File[] }>).detail;
      if (detail.botId !== bot.id) return;
      if (!attach.current(detail.files)) return;
      event.preventDefault();
      if (!compact) ref.current?.focus();
    };
    window.addEventListener(ATTACH_EVENT, onAttach);
    return () => window.removeEventListener(ATTACH_EVENT, onAttach);
  }, [bot.id, compact]);

  // Server transcription goes where the caret was when recording began (kept in step with the user's edits by
  // composerDictation.noteEdit) and never replaces text that was edited since.
  const insertText = (t: string, range?: TextRange) => {
    const el = ref.current;
    let caret = el && document.activeElement === el ? el.selectionStart : undefined;
    // The box already shows the live words where they belong: a caret right after them (or inside) is "at the
    // insertion point", and one further on is measured without them.
    const live = liveSpanShown.current;
    if (caret !== undefined && live.len) caret = caret >= live.at + live.len ? caret - live.len : caret > live.at ? undefined : caret;
    const placed = insertDictated(getDraft(bot.id), t, range, caret);
    setText(placed.value);
    if (caret !== undefined) requestAnimationFrame(() => { if (el && document.activeElement === el) el.setSelectionRange(placed.caret, placed.caret); });
  };
  // Dictation runs in a host that outlives this chat box (see voice/composerDictation). This box registers as
  // the place its words go; switching chats hands that role to the next chat box without stopping the recording.
  useLayoutEffect(() => registerDictationSink({
    botId: bot.id,
    insert: insertText,
    words: (spoken, range) => {
      const heard = spoken.trim();
      if (!heard) return range?.end;
      const placed = insertDictated(getDraft(bot.id), heard, range);
      setText(placed.value);
      return range ? placed.caret : undefined;
    },
    error: setMicError,
  }), [bot.id]);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);
  const state = useComposerDictation(s => s.state);
  const liveWords = useComposerDictation(s => s.interim);
  // Where dictation began: the words being heard are drawn right there (not at the end of the box).
  const anchor = useComposerDictation(s => s.anchor?.botId === bot.id ? s.anchor.at : undefined);
  const span = liveSpan(text, liveWords, anchor);
  const shown = withSpan(text, span);
  const tail = span.tail;
  // Setting the box's value moves the browser caret to the end, so remember where it was and put it back: right after
  // the live words when it was on them, otherwise where the user left it.
  const domBefore = useRef<{ value: string; caret: number; focused: boolean }>();
  const field = ref.current;
  domBefore.current = field ? { value: field.value, caret: field.selectionStart, focused: document.activeElement === field } : undefined;
  useLayoutEffect(() => {
    const el = ref.current;
    const before = domBefore.current;
    const previous = liveSpanShown.current;
    liveSpanShown.current = { at: span.at, len: span.tail.length };
    if (!el || !before?.focused || before.value === shown || !(previous.len || span.tail)) return;
    const caret = before.caret >= previous.at && before.caret <= previous.at + previous.len ? span.end
      : before.caret > previous.at + previous.len ? before.caret + span.tail.length - previous.len : before.caret;
    const place = Math.max(0, Math.min(caret, shown.length));
    el.setSelectionRange(place, place);
  }, [shown, span.at, span.end, span.tail]);
  const discardDictation = composerDictation.discard;
  const stopDictation = composerDictation.stop;
  const startDictation = () => {
    if (inCall || localCall) { setMicError('End the voice call before starting dictation.'); return; }
    setMicError(null);
    setAudioMenu(false);
    const input = ref.current;
    // The live words appear at the caret (after a selection), not at the end of the box.
    composerDictation.start(bot.id, input && document.activeElement === input ? { start: input.selectionEnd, end: input.selectionEnd } : undefined);
  };
  const toggleDictation = () => {
    if (state === 'recording') stopDictation();
    else if (state === 'idle') startDictation();
  };
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
    void list().catch(cause => setMicError(micErrorMessage(cause)));
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

  const detailsOpen = useDetailsOpen();
  const say = (message: string) => { setError(null); setNotice(message); };
  const room = bot.kind === 'room';
  type Command = { label: string; detail: string; icon: ReactNode; onSelect: () => void; aliases?: string[] };
  const commands: Command[] = [
    { label: '/clear', detail: 'Start a new conversation', icon: <Eraser size={15} />, aliases: ['/new', '/reset'], onSelect: () => {
      say('Starting a new conversation…');
      api.fresh(bot.id).then(() => say('Started a new conversation.')).catch(e => setError((e as Error).message));
    } },
    ...(room ? [] : [{ label: '/compact', detail: 'Summarize older messages to save tokens', icon: <Shrink size={15} />, onSelect: () => {
      if (running) { setError('Wait for the reply to finish, then compact.'); return; }
      say('Compacting…');
      featuresApi.compact(bot.id).then(result => say(`Compacted to about ${formatTokens(result.tokens)} tokens.`)).catch(e => setError((e as Error).message));
    } }]),
    { label: '/stats', detail: 'Subscription usage and limits', icon: <BarChart3 size={15} />, aliases: ['/usage', '/limits'], onSelect: () => setModal('usage') },
    ...(running ? [{ label: '/stop', detail: 'Stop the current reply', icon: <Square size={15} />, onSelect: () => void stop() }] : []),
    ...(room ? [] : [{ label: '/learn', detail: 'Turn this chat’s corrections into lessons and skills', icon: <Brain size={15} />, onSelect: () => {
      say('Learning from this chat…');
      featuresApi.improve(bot.id).then(result => say(result.lessons || result.skills
        ? `Learned ${result.lessons} lesson${result.lessons === 1 ? '' : 's'} and updated ${result.skills} skill${result.skills === 1 ? '' : 's'}.`
        : 'Nothing new to learn from this chat yet.')).catch(e => setError((e as Error).message));
    } }]),
    ...(room ? [] : [{ label: '/team', detail: 'Orchestrate several models together', icon: <Users size={15} />, onSelect: () => setModal('team') }]),
    { label: '/call', detail: `Start a voice call with ${displayName(bot)}`, icon: <Phone size={15} />, onSelect: openCall },
    { label: '/dictate', detail: 'Toggle dictation', icon: <Mic size={15} />, onSelect: toggleDictation },
    { label: '/attach', detail: 'Add files or photos', icon: <Paperclip size={15} />, onSelect: chooseFiles },
    { label: '/screenshots', detail: `Attach a recent screenshot (${SCREENSHOT_SHORTCUT_LABEL})`, icon: <Images size={15} />, aliases: ['/shots'], onSelect: () => setModal('screenshots') },
    ...(room ? [] : [{ label: '/teach', detail: 'Teach by screen recording', icon: <ScreenRecordGlyph size={15} />, onSelect: () => useFeatureUI.getState().set({ teachBotId: bot.id }) }]),
    { label: '/details', detail: detailsOpen ? 'Hide the side panel' : 'Show the side panel', icon: <PanelRight size={15} />, onSelect: () => setDetailsOpen(!detailsOpen) },
    { label: '/bot', detail: `${displayName(bot)}’s settings, skills and memories`, icon: <Sliders size={15} />, onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
    { label: '/apps', detail: 'Connect apps', icon: <Activity size={15} />, onSelect: () => setModal('apps') },
    { label: '/settings', detail: 'Marion Agent settings', icon: <Settings size={15} />, aliases: ['/preferences'], onSelect: () => useConfigUI.getState().openAppSettings() },
  ];
  const findCommand = (typed: string) => commands.find(item => item.label === typed || item.aliases?.includes(typed));
  const runCommand = (command: Command) => {
    discardDictation();
    setText('');
    setSlashIndex(0);
    if (['/stats', '/apps', '/team', '/bot', '/settings'].includes(command.label)) plusButton.current?.focus();
    else ref.current?.focus();
    command.onSelect();
  };
  // Typing "/" at the start opens the command list, filtered as you type.
  const slashQuery = /^\/[\w-]*$/.test(shown) && !files.length ? shown.toLowerCase() : null;
  const slashMatches = slashQuery === null || slashQuery === slashDismissed ? [] : commands.filter(command =>
    command.label.startsWith(slashQuery) || command.aliases?.some(alias => alias.startsWith(slashQuery)));
  const slashOpen = slashMatches.length > 0;
  const slashActive = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
  useEffect(() => { setSlashIndex(0); }, [slashQuery]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!micError) return;
    const timer = window.setTimeout(() => setMicError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [micError]);
  // The mic pill keeps its last words while it fades out, so closing is as smooth as opening.
  const micText = state === 'recording' ? 'Listening…' : state === 'transcribing' ? 'Transcribing…' : micError;
  const lastMicText = useRef(micText);
  if (micText) lastMicText.current = micText;
  const micTone = state !== 'idle' ? 'live' : 'error';
  const lastMicTone = useRef(micTone);
  if (micText) lastMicTone.current = micTone;
  const hasMessage = shown.trim().length > 0 || files.length > 0;
  // The composer floats over the conversation: tell the chat how tall it is so the last message clears it.
  const areaObserver = useRef<ResizeObserver>();
  const measureArea = useCallback((node: HTMLDivElement | null) => {
    areaObserver.current?.disconnect();
    if (!node) return;
    const chat = node.closest<HTMLElement>('.chat');
    if (!chat) return;
    areaObserver.current = new ResizeObserver(() => chat.style.setProperty('--composer-h', `${Math.ceil(node.getBoundingClientRect().height)}px`));
    areaObserver.current.observe(node);
  }, []);
  const multiline = shown.includes('\n') || lines > 1;

  return (
    <div ref={measureArea} className={`composer-area${dropping ? ' is-dropping' : ''}`}
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
      {dropping && <div className="composer-drop" aria-hidden="true">Drop screenshots, screen recordings or files to attach</div>}
      {notice && !error && <div className="composer__error composer__notice" role="status">{notice}</div>}
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className="composer__progress" role="status" data-visible={sending}>
        <span className="loading-dot" aria-hidden="true" />Sending…
      </div>
      {reply && (
        <div className="composer-reply" role="group" aria-label="Replying to">
          <span className="composer-reply__text">
            <span className="composer-reply__name">Replying to {reply.name}</span>
            <span className="composer-reply__quote">{reply.text}</span>
          </span>
          <button type="button" className="composer-reply__close" aria-label="Cancel reply" title="Cancel reply" disabled={sending}
            onClick={() => { useMessageActions.getState().setReply(bot.id, null); ref.current?.focus(); }}><Icon name="close" size={12} /></button>
        </div>
      )}
      {/* Attachments sit above the model/effort/Team/dictation row. */}
      {files.length > 0 && <ul className="composer-files" aria-label="Draft attachments">
        {files.map((file, index) => <DraftAttachment key={`${file.name}:${file.lastModified}:${index}`} file={file} disabled={sending}
          remove={() => setFiles(current => current.filter((_, position) => position !== index))} />)}
      </ul>}
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
        <div className={`mic-note is-${lastMicTone.current}`} data-visible={!!micText} role={micTone === 'error' && micText ? 'alert' : 'status'} aria-hidden={!micText}>
          {lastMicTone.current === 'live' ? <VoiceWave active={state === 'recording'} /> : <MicOff size={13} aria-hidden="true" />}
          <span className="mic-note__text">{lastMicText.current}</span>
          {lastMicTone.current === 'error' && <button type="button" className="mic-note__close" tabIndex={micText ? 0 : -1} onClick={() => setMicError(null)} aria-label="Dismiss"><Icon name="close" size={9} /></button>}
        </div>
      </div>
      {slashOpen && (
        <div className="slash-menu" id={`${inputId}-commands`} role="listbox" aria-label="Commands">
          <div className="slash-menu__header">Commands</div>
          {slashMatches.map((command, index) => (
            <button key={command.label} id={`${inputId}-command-${index}`} type="button" role="option" aria-selected={index === slashActive} tabIndex={-1}
              className={`slash-menu__item${index === slashActive ? ' is-active' : ''}`}
              onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSlashIndex(index)} onClick={() => runCommand(command)}>
              <span className="slash-menu__icon" aria-hidden="true">{command.icon}</span>
              <span className="slash-menu__label">{command.label}</span>
              <span className="slash-menu__detail">{command.detail}</span>
            </button>
          ))}
          <div className="slash-menu__footer"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to run · <kbd>Esc</kbd> to close</div>
        </div>
      )}
      <div className={`composer${multiline ? ' is-multiline' : ''}`}>
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <input ref={fileInput} type="file" multiple hidden accept={[...photoTypes, ...videoTypes, '.mov,.mp4,.m4v,.webm', textFiles].join(',')} onChange={event => {
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
                  { label: 'Recent screenshots', hint: SCREENSHOT_SHORTCUT_LABEL, icon: <Images size={16} />, onSelect: () => setModal('screenshots') },
                  ...(bot.kind === 'room' ? [] : [{ label: 'Teach by screen recording', icon: <ScreenRecordGlyph size={16} />, onSelect: () => useFeatureUI.getState().set({ teachBotId: bot.id }) }]),
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
            onChange={(e) => {
              // Typing, backspacing and deleting never stop dictation: the edit goes into the text you wrote, and the
              // place dictated words will land follows it.
              const edit = reconcileEdit(text, tail, e.target.value, span.at);
              composerDictation.noteEdit(bot.id, edit);
              setText(edit.text);
            }}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (!pasted.length) return;
              e.preventDefault();
              addFiles(pasted.map(named));
            }}
            onKeyDown={(e) => {
              if (slashOpen && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setSlashIndex((slashActive + step + slashMatches.length) % slashMatches.length);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); runCommand(slashMatches[slashActive]); return; }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSlashDismissed(slashQuery ?? ''); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-controls={slashOpen ? `${inputId}-commands` : undefined}
            aria-activedescendant={slashOpen ? `${inputId}-command-${slashActive}` : undefined} aria-autocomplete="list"
            aria-label={`Message ${bot.name}`}
          />
        </div>
        <div className="composer__right">
          <span className="composer__mic-anchor"><button
            type="button"
            className={`composer__btn composer__mic${state === 'recording' ? ' is-recording' : state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={state === 'recording'} aria-keyshortcuts={dictationShortcut()}
            title={state === 'recording' ? 'Tap to stop · Esc cancels' : `Dictate (${shortcutLabel(dictationShortcut())}) · Right-click for audio input`}
            disabled={state === 'transcribing'}
            onPointerDown={pressMic}
            onPointerUp={releaseMic}
            onClick={event => { if (event.detail === 0) toggleDictation(); }}
            onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showInputs(); } }}
            onPointerCancel={() => { if (micPress.current?.started) discardDictation(); micPress.current = undefined; }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showInputs(); }}
          >
            <MicSolid size={15} fill={28} />
          </button>
          {audioMenu && <Menu label="Audio input" placement="above" align="right" className="microphone-menu" onClose={() => setAudioMenu(false)} items={[
            { label: 'System default', checked: selectedInput === '', onSelect: () => selectMic('') },
            ...inputs.map((device, index) => ({ label: device.label || `Microphone ${index + 1}`, checked: selectedInput === device.deviceId, onSelect: () => selectMic(device.deviceId) })),
            { label: 'Refresh microphone list', separator: true, onSelect: () => showInputs(true) },
          ]}><div className="menu__header">Audio input</div></Menu>}
          </span>
          {(inCall || localCall) && !hasMessage ? (
            <button type="button" className={`composer__cta is-in-call${ringing ? ' is-call-ringing' : ''}`} onClick={() => localCall ? endLocalCall() : endCall()} aria-label="End call" title="End call">
              <PhoneOff className="call-handset" size={15} aria-hidden />
            </button>
          ) : running && !hasMessage ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <span className="composer__call-anchor">
              <button
                type="button"
                className={`composer__cta${hasMessage ? '' : ' is-call'}`}
                onClick={hasMessage ? send : openCall}
                onContextMenu={hasMessage ? undefined : event => { event.preventDefault(); event.stopPropagation(); showCallMenu(); }}
                onKeyDown={hasMessage ? undefined : event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showCallMenu(); } }}
                disabled={hasMessage && (sending || savingModel)}
                aria-label={hasMessage ? 'Send' : `Call ${bot.name}`}
                title={hasMessage ? 'Send (Enter)' : `Call ${bot.name} · Right-click to choose the call model`}
              >
                {hasMessage ? <Icon name="arrow_up" size={16} /> : <PhoneSolid size={15} />}
              </button>
              {callMenu && <Menu label="Call model" placement="above" align="right" className="chat-model__menu" onClose={() => setCallMenu(false)} items={[
                { label: `Same as chat · ${bot.chatModel?.label ?? bot.chatModel?.model ?? 'chat model'}`, checked: !callModelFor(bot.id), onSelect: () => setChatCallModel(bot.id, null) },
                ...(callModels === null ? [{ label: 'Loading models…', disabled: true, onSelect: () => {} }] : callModels.map(model => {
                  const chosen = callModelFor(bot.id);
                  return {
                    group: ({ local: 'Local models', codex: 'Codex', gemini: 'Gemini', claude: 'Claude' } as const)[model.provider],
                    label: model.label, checked: chosen?.provider === model.provider && chosen.model === model.id,
                    onSelect: () => setChatCallModel(bot.id, { provider: model.provider, model: model.id, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort, label: model.label }),
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
