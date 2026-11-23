import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { sortedRows, useStore } from '../store';
import { useDictation } from '../voice/dictation';

export function LocalVoicePanel({ bot, close }: { bot: Bot; close: () => void }) {
  const [pending, setPending] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const [reply, setReply] = useState('');
  const transcript = useStore(state => state.transcripts[bot.id]);
  const live = useStore(state => state.live[bot.id]);
  const mounted = useRef(false);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);

  function speak(text: string) {
    const engine = window.speechSynthesis;
    const voices = engine?.getVoices().filter(voice => voice.localService) ?? [];
    const voice = voices.find(voice => voice.lang === bot.voiceLanguage)
      ?? voices.find(voice => voice.lang.split('-')[0] === (bot.voiceLanguage === 'auto' ? navigator.language : bot.voiceLanguage).split('-')[0])
      ?? voices[0];
    if (!engine || !voice) { setStatus('No local speech voice is available in this browser. You can read the reply in chat.'); return; }
    try {
      engine.cancel();
      const audio = new SpeechSynthesisUtterance(text.slice(0, 4000));
      audio.voice = voice;
      audio.lang = voice.lang;
      audio.rate = bot.voiceSpeed || 1;
      audio.onerror = () => { if (mounted.current && utterance.current === audio) setStatus('Could not play the reply. Try Play reply.'); };
      utterance.current = audio;
      engine.speak(audio);
    } catch {
      setStatus('Could not play the reply. You can read it in chat.');
    }
  }

  useEffect(() => {
    mounted.current = true;
    // Load the operating system's voice list before the first reply.
    window.speechSynthesis?.getVoices();
    return () => {
      mounted.current = false;
      if (utterance.current) window.speechSynthesis?.cancel();
    };
  }, []);

  const dictation = useDictation(async (text) => {
    setSending(true); setStatus('');
    try {
      const { row } = await api.send(bot.id, text);
      if (mounted.current) setPending(row.seq);
    } catch (error) {
      if (mounted.current) setStatus((error as Error).message);
    } finally {
      if (mounted.current) setSending(false);
    }
  }, setStatus, bot.voiceLanguage);

  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => {
      setPending(null);
      setStatus('The reply is taking longer than expected. Check the chat transcript.');
    }, 6 * 60_000);
    return () => clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (pending === null || live?.isRunning || live?.awaiting) return;
    const rows = sortedRows(transcript).filter(row => row.seq > pending);
    const last = rows.at(-1)?.body;
    if (!last) return;
    if (last.type === 'notice' && (last.tone === 'error' || last.text === 'Stopped.')) {
      setStatus(last.text); setPending(null);
      return;
    }
    if (last.type === 'message' && last.role === 'assistant' && !last.streaming) {
      setReply(last.text); setPending(null); setStatus(''); speak(last.text);
    }
    // Evaluate the latest reply after each transcript or activity change.
  }, [pending, transcript, live]);

  const waiting = sending || pending !== null;
  const recording = dictation.state === 'recording';
  const activity = live?.awaiting && waiting ? 'Review the approval in chat.'
    : waiting ? 'Waiting for reply…'
    : dictation.state === 'transcribing' ? 'Transcribing…'
    : recording ? 'Listening…' : '';

  return (
    <section className="local-voice" aria-label="Local voice chat">
      <div>
        <strong>Voice chat with {bot.name}</strong>
        {(activity || status) && <div className="cfg-field__hint" role="status">{activity || status}</div>}
      </div>
      <button type="button" className="btn btn--primary" disabled={waiting || dictation.state === 'transcribing' || (!recording && Boolean(live?.isRunning))} onClick={() => {
        if (recording) dictation.finish();
        else { setStatus(''); setReply(''); void dictation.begin(); }
      }}>{recording ? 'Stop and send' : 'Record message'}</button>
      {reply && <button type="button" className="btn btn--secondary" onClick={() => speak(reply)}>Play reply</button>}
      <button type="button" className="btn btn--secondary" onClick={close}>End voice chat</button>
    </section>
  );
}
