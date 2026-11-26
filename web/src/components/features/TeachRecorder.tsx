import { useEffect, useRef, useState } from 'react';
import { Circle, History, Mic, MicOff, Square, Trash2, Upload, X } from 'lucide-react';
import { featuresApi, useFeatureUI, type TeachRecording } from '../../lib/featuresApi';
import { relativeShort } from '../../lib/time';
import { displayName, useStore } from '../../store';
import { voiceApi } from '../../voice/api';
import { micErrorMessage, openMic } from '../../voice/audio';
import { Modal } from '../modals/Modal';

const MAX_SECONDS = 10 * 60;
const MAX_FRAMES = 12;
const SAMPLE_MS = 1000;
const FRAME_WIDTH = 1280;

interface Frame { blob: Blob; url: string; at: number }

/** Fingerprint of a frame: 32x18 grayscale, used to keep only frames where the screen changed. */
function fingerprint(source: HTMLCanvasElement, scratch: HTMLCanvasElement) {
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, 32, 18);
  const { data } = ctx.getImageData(0, 0, 32, 18);
  const out = new Uint8Array(32 * 18);
  for (let i = 0; i < out.length; i++) out[i] = (data[i * 4] * 3 + data[i * 4 + 1] * 6 + data[i * 4 + 2]) / 10;
  return out;
}

function difference(a: Uint8Array, b: Uint8Array) {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 18) changed++;
  return changed / a.length;
}

/** Pick at most `max` frames spread across the recording, always keeping the first and last. */
export function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const picked: T[] = [];
  for (let i = 0; i < max; i++) picked.push(items[Math.round(i * (items.length - 1) / (max - 1))]);
  return [...new Set(picked)];
}

type Phase = 'setup' | 'recording' | 'review' | 'sending';

/** Key moments from an uploaded screen recording: step through the video and keep frames where the screen changed. */
async function framesFromFile(file: File): Promise<{ frames: Frame[]; seconds: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.src = url; video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('This video can’t be opened here. Try an .mp4, .mov or .webm file.'));
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration || !video.videoWidth) throw new Error('The video has no picture.');
    const canvas = document.createElement('canvas');
    const scratch = document.createElement('canvas');
    scratch.width = 32; scratch.height = 18;
    const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const step = Math.max(0.5, duration / 120);
    const candidates: Frame[] = [];
    let lastPrint: Uint8Array | null = null;
    let lastKept = -Infinity;
    for (let t = 0; t <= duration; t += step) {
      await new Promise<void>(resolve => { video.onseeked = () => resolve(); video.currentTime = Math.min(t, duration - 0.05); });
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const print = fingerprint(canvas, scratch);
      if (lastPrint && difference(print, lastPrint) <= 0.04 && t - lastKept < 15) continue;
      lastPrint = print; lastKept = t;
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.72));
      if (blob) candidates.push({ blob, url: '', at: Math.round(t * 1000) });
    }
    return { frames: spread(candidates, MAX_FRAMES).map(f => ({ ...f, url: URL.createObjectURL(f.blob) })), seconds: Math.round(duration) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function TeachRecorder({ botId }: { botId: string }) {
  const bot = useStore(s => s.bots.find(b => b.id === botId));
  const close = () => useFeatureUI.getState().set({ teachBotId: null });
  const [phase, setPhase] = useState<Phase>('setup');
  const [title, setTitle] = useState('');
  const [narrate, setNarrate] = useState(true);
  const [notes, setNotes] = useState('');
  const [narration, setNarration] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const session = useRef<{ stop: () => void } | null>(null);
  const started = useRef(0);
  const savedId = useRef<string | null>(null);
  const source = useRef<'screen' | 'upload'>('screen');
  const fileInput = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<TeachRecording[] | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => { featuresApi.recordings(botId).then(r => setHistory(r.recordings)).catch(() => setHistory([])); }, [botId]);

  /** Saved the moment a recording ends, so closing the window loses nothing (Settings → General → Bots sets how long). */
  const keep = async (kept: Frame[], seconds: number, extra: { narration?: string } = {}) => {
    const form = new FormData();
    if (savedId.current) form.append('id', savedId.current);
    form.append('title', title.trim());
    form.append('narration', extra.narration ?? narration);
    form.append('notes', notes);
    form.append('seconds', String(seconds));
    form.append('source', source.current);
    if (!savedId.current) {
      form.append('times', kept.map(f => f.at).join(','));
      kept.forEach((f, i) => form.append('frames', f.blob, `step-${i + 1}.jpg`));
    }
    try { savedId.current = (await featuresApi.saveRecording(botId, form)).id; } catch { /* history is best effort */ }
  };

  const importFile = async (file: File) => {
    setError(''); setImporting(true);
    try {
      const { frames: kept, seconds } = await framesFromFile(file);
      if (!kept.length) throw new Error('No key moments were found in that video.');
      source.current = 'upload'; savedId.current = null;
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 120));
      setFrames(kept); setElapsed(seconds); setNarration(''); setPhase('review');
      void keep(kept, seconds);
    } catch (e) { setError((e as Error).message); } finally { setImporting(false); }
  };

  const reopen = async (recording: TeachRecording) => {
    setError(''); setImporting(true);
    try {
      const kept = await Promise.all(recording.frames.map(async frame => {
        const blob = await fetch(`/api/recordings/${recording.id}/${frame.name}`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('A frame is missing.'); return r.blob(); });
        return { blob, url: URL.createObjectURL(blob), at: frame.at };
      }));
      savedId.current = recording.id; source.current = recording.source;
      setTitle(recording.title); setNarration(recording.narration); setNotes(recording.notes);
      setFrames(kept); setElapsed(recording.seconds); setPhase('review');
    } catch (e) { setError((e as Error).message); } finally { setImporting(false); }
  };

  useEffect(() => () => { session.current?.stop(); }, []);
  useEffect(() => () => { frames.forEach(f => URL.revokeObjectURL(f.url)); }, [frames]);

  const start = async () => {
    setError('');
    if (!navigator.mediaDevices?.getDisplayMedia) { setError('Screen recording isn’t available here. Use Marion Agent on the Mac.'); return; }
    let screen: MediaStream;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    } catch (e) {
      setError((e as DOMException).name === 'NotAllowedError'
        ? 'Screen recording was blocked. Allow Marion Agent in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.'
        : `Couldn’t start screen recording: ${(e as Error).message}`);
      return;
    }
    let mic: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    const audio: Blob[] = [];
    if (narrate) {
      try {
        mic = await openMic();
        recorder = new MediaRecorder(mic);
        recorder.ondataavailable = e => { if (e.data.size) audio.push(e.data); };
        recorder.start(1000);
      } catch (e) {
        setError(`Recording without narration: ${micErrorMessage(e)}`);
      }
    }
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = screen;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const scratch = document.createElement('canvas');
    scratch.width = 32; scratch.height = 18;
    const candidates: Frame[] = [];
    let lastPrint: Uint8Array | null = null;
    let lastKept = 0;
    started.current = Date.now();
    savedId.current = null;
    setFrames([]);
    setElapsed(0);
    setPhase('recording');

    const sample = () => {
      if (!video.videoWidth) return;
      const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const print = fingerprint(canvas, scratch);
      const now = Date.now();
      const changed = !lastPrint || difference(print, lastPrint) > 0.04;
      if (!changed && now - lastKept < 15_000) return;
      lastPrint = print;
      lastKept = now;
      canvas.toBlob(blob => {
        if (!blob) return;
        candidates.push({ blob, url: '', at: now - started.current });
        // Keep memory bounded on long recordings: thin out evenly once there are many.
        if (candidates.length > 60) candidates.splice(0, candidates.length, ...spread(candidates, 40));
      }, 'image/jpeg', 0.72);
    };
    const timer = window.setInterval(() => {
      sample();
      const seconds = Math.round((Date.now() - started.current) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_SECONDS) finish();
    }, SAMPLE_MS);
    sample();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      sample();
      screen.getTracks().forEach(t => t.stop());
      const done = () => {
        mic?.getTracks().forEach(t => t.stop());
        window.setTimeout(() => {
          const kept = spread(candidates, MAX_FRAMES).map(f => ({ ...f, url: URL.createObjectURL(f.blob) }));
          const seconds = Math.round((Date.now() - started.current) / 1000);
          setFrames(kept);
          setElapsed(seconds);
          setPhase('review');
          source.current = 'screen'; savedId.current = null;
          void keep(kept, seconds);
          if (audio.length) void transcribe(new Blob(audio, { type: recorder?.mimeType || 'audio/webm' }));
        }, 150);
      };
      if (recorder && recorder.state !== 'inactive') { recorder.onstop = done; recorder.stop(); } else done();
    };
    // The user can also stop from the system's own "Stop sharing" control.
    screen.getVideoTracks()[0]?.addEventListener('ended', finish, { once: true });
    session.current = { stop: finish };
  };

  const transcribe = async (blob: Blob) => {
    setTranscribing(true);
    try {
      const status = await voiceApi.status();
      if (!status.localSpeech && !status.realtime && !status.nativeSpeech) {
        setError('Narration was recorded, but no speech service is set up (Settings → Audio). Type what you did in the notes instead.');
        return;
      }
      const text = await voiceApi.transcribe(blob, bot?.voiceLanguage, undefined, status.nativeSpeech);
      setNarration(current => current || text);
      if (savedId.current) void keep([], 0, { narration: text });
    } catch (e) {
      setError(`Couldn’t transcribe the narration: ${(e as Error).message}. Type it in the notes instead.`);
    } finally { setTranscribing(false); }
  };

  const send = async () => {
    if (!frames.length) return;
    setPhase('sending');
    setError('');
    const form = new FormData();
    form.append('title', title.trim() || 'New skill');
    form.append('narration', narration.trim());
    form.append('notes', notes.trim());
    form.append('seconds', String(elapsed));
    frames.forEach((f, i) => form.append('frames', f.blob, `step-${i + 1}.jpg`));
    try {
      await featuresApi.teach(botId, form);
      void keep([], elapsed);
      close();
    } catch (e) {
      setError((e as Error).message);
      setPhase('review');
    }
  };

  if (!bot) return null;
  const minutes = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  return (
    <Modal onClose={() => { if (phase !== 'recording' && phase !== 'sending') close(); }} className="teach-modal" label="Teach by screen recording">
      <div className="modal__header">
        <div className="modal__title">Teach {displayName(bot)}</div>
        {phase !== 'recording' && <button type="button" className="modal__close" onClick={close} aria-label="Close"><X size={15} /></button>}
      </div>
      <div className="teach-modal__body">
        {phase === 'setup' && <>
          <p className="teach-modal__lead">Show {bot.name} how you do something. Record your screen while you do it once, talking through the steps if you like. {bot.name} turns it into a skill it can repeat on its own computer.</p>
          <label className="teach-modal__field">
            <span>What are you teaching?</span>
            <input className="text-input" value={title} maxLength={120} autoFocus placeholder="e.g. Export last week’s invoices" onChange={e => setTitle(e.target.value)} />
          </label>
          <button type="button" className={`teach-modal__toggle${narrate ? ' is-on' : ''}`} onClick={() => setNarrate(!narrate)} aria-pressed={narrate}>
            {narrate ? <Mic size={16} /> : <MicOff size={16} />} {narrate ? 'Narrate with the microphone' : 'No narration'}
          </button>
          <p className="teach-modal__hint">You’ll pick a window or screen next. Up to 10 minutes. Marion keeps up to {MAX_FRAMES} key moments, not the whole video.</p>
          <div className="teach-modal__or"><span>or</span></div>
          <button type="button" className="teach-modal__upload" onClick={() => fileInput.current?.click()} disabled={importing}>
            <Upload size={16} /> {importing ? 'Reading the video…' : 'Upload a screen recording'}
            <small>.mov, .mp4 or .webm. Marion picks the key moments from it.</small>
          </button>
          <input ref={fileInput} type="file" accept="video/*,.mov,.mp4,.webm,.m4v" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
          {!!history?.length && (
            <div className="teach-history">
              <div className="teach-history__head"><History size={13} /> Recent recordings</div>
              {history.slice(0, 6).map(recording => (
                <div key={recording.id} className="teach-history__row">
                  <button type="button" className="teach-history__open" onClick={() => void reopen(recording)} disabled={importing}>
                    <img src={recording.frames[0] ? `/api/recordings/${recording.id}/${recording.frames[0].name}` : undefined} alt="" />
                    <span><b>{recording.title || 'Untitled recording'}</b><small>{recording.source === 'upload' ? 'Uploaded' : 'Recorded'} {relativeShort(recording.createdAt) === 'now' ? 'just now' : `${relativeShort(recording.createdAt)} ago`} · {recording.frames.length} moments · kept until {new Date(recording.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span>
                  </button>
                  <button type="button" className="icon-btn icon-btn--sm" aria-label={`Delete ${recording.title || 'recording'}`} title="Delete"
                    onClick={() => featuresApi.deleteRecording(recording.id).then(() => setHistory(list => list?.filter(r => r.id !== recording.id) ?? null)).catch(() => {})}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </>}
        {phase === 'recording' && <div className="teach-modal__recording">
          <span className="teach-modal__dot" aria-hidden="true" />
          <div>
            <strong>Recording {minutes}</strong>
            <p>Do the task now. Come back here and press Stop when you’re done.</p>
          </div>
        </div>}
        {(phase === 'review' || phase === 'sending') && <>
          <div className="teach-modal__frames" aria-label={`${frames.length} key moments`}>
            {frames.map((f, i) => <figure key={f.url}><img src={f.url} alt={`Moment ${i + 1}`} /><figcaption>{i + 1} · {Math.round(f.at / 1000)}s</figcaption></figure>)}
          </div>
          <label className="teach-modal__field">
            <span>Skill name</span>
            <input className="text-input" value={title} maxLength={120} placeholder="e.g. Export last week’s invoices" onChange={e => setTitle(e.target.value)} />
          </label>
          <label className="teach-modal__field">
            <span>{transcribing ? 'Transcribing your narration…' : 'What you said'}</span>
            <textarea className="text-input" rows={3} value={narration} onChange={e => setNarration(e.target.value)} placeholder={narrate ? '' : 'No narration recorded'} />
          </label>
          <label className="teach-modal__field">
            <span>Anything else {bot.name} should know</span>
            <textarea className="text-input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional: logins it will need, what to double-check…" />
          </label>
        </>}
        {error && <p className="card__error" role="alert">{error}</p>}
      </div>
      <div className="modal__footer">
        {phase === 'setup' && <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={close}>Cancel</button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void start()}><Circle size={12} fill="currentColor" /> Start recording</button>
        </>}
        {phase === 'recording' && <button type="button" className="btn btn--primary btn--sm" onClick={() => session.current?.stop()}><Square size={12} fill="currentColor" /> Stop</button>}
        {(phase === 'review' || phase === 'sending') && <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setPhase('setup'); setFrames([]); setNarration(''); }} disabled={phase === 'sending'}>Record again</button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void send()} disabled={phase === 'sending' || transcribing || !frames.length}>
            {phase === 'sending' ? 'Sending…' : `Send to ${bot.name}`}
          </button>
        </>}
      </div>
    </Modal>
  );
}
