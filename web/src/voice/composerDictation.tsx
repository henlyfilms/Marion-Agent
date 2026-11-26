// Chat-box dictation that outlives the chat it started in.
//
// The two dictation engines (recorded + live) used to live inside each chat's Composer, which is re-created on
// every chat switch, so switching chats cut dictation off. They now live in <ComposerDictationHost/>, mounted once
// for the whole workspace. Whichever Composer is on screen registers itself as the "sink" for dictated words, so
// when you switch chats the recording keeps going and the words land in the chat you switched to.
import { useEffect, useLayoutEffect, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { useCompactLayout } from '../lib/layout';
import { voiceApi, type VoiceStatus } from './api';
import { microphoneId } from './audio';
import { useDictation, type DictationState } from './dictation';
import { supportsLiveDictation, useLiveDictation } from './liveDictation';
import { playDictationSound } from './sounds';
import { createDictationRouter } from './dictationRouting';

import { getDraft, setDraft, flushDrafts } from '../lib/drafts';
import { applyCut, insertDictated, shiftRange, type HeardCut, type TextEdit, type TextRange } from './dictationText';
export type { TextRange } from './dictationText';

/** The chat box currently on screen: where dictated words go. */
export interface DictationSink {
  botId: string;
  /** Finished transcription from the speech server, inserted at `range` (where the caret was when it started). */
  insert(text: string, range?: TextRange): void;
  /**
   * Final words from live (browser) dictation, inserted at `range` (the dictation anchor) or appended at the end
   * when there is none. Returns the caret position right after the inserted words when `range` was given.
   */
  words(words: string, range?: TextRange): number | undefined;
  error(message: string): void;
}

/** Where dictated words go in one chat's box: the committed-text offset the live words are drawn at. */
interface DictationAnchor { botId: string; at: number }
interface DictationView { state: DictationState; interim: string; anchor?: DictationAnchor }
/** What every chat box shows: whether dictation is running, the words heard so far and where they belong. */
export const useComposerDictation = create<DictationView>(() => ({ state: 'idle', interim: '' }));

interface Controls {
  start(botId: string, range?: TextRange): void;
  stop(): void;
  discard(): void;
  /** Leaving the chat: end dictation now and keep every word heard, saved in that chat's draft. */
  commit(): void;
}

let controls: Controls | undefined;
/** Where a recorded dictation began, so its caret position is only reused in that same chat. */
let origin: { botId: string; range?: TextRange } | undefined;
let touchLive: (() => void) | undefined;
/** Words the user deleted from what is still being heard: they must not come back with the engine's next update. */
let cut: HeardCut | undefined;
/** What the engine reports as heard right now (before any cut). */
let rawInterim = '';
/** The engine's text with the user's deletions applied; a different utterance clears the cut. */
function filterHeard(text: string) {
  const result = applyCut(cut, text);
  cut = result.cut;
  return result.text;
}
/** Moves the dictation anchor and publishes it, so the chat box draws live words right at the caret where dictation began. */
function setOrigin(next: typeof origin) {
  origin = next;
  const at = next?.range?.end;
  const anchor = next && at !== undefined ? { botId: next.botId, at } : undefined;
  const current = useComposerDictation.getState().anchor;
  if (current?.botId !== anchor?.botId || current?.at !== anchor?.at) useComposerDictation.setState({ anchor });
}

// Read navigation synchronously: React may not have committed the incoming Composer yet.
function chatTarget() {
  const { selectedBotId, mobileChatOpen, bots } = useStore.getState();
  const { view, appSettings, botSettings } = useConfigUI.getState();
  if (view !== 'chat' || appSettings || botSettings ||
      (!mobileChatOpen && window.matchMedia('(max-width: 700px)').matches)) return;
  if (bots.some(bot => bot.id === selectedBotId)) return selectedBotId ?? undefined;
}

const routing = createDictationRouter<DictationSink>(chatTarget);
export const registerDictationSink = routing.register;

export const composerDictation: Controls & {
  /** The user typed or deleted text. Dictation keeps running; only its insertion point follows the edit. */
  noteEdit(botId: string, edit: TextEdit): void;
  /** The user deleted `range` of the words still being heard: drop them for good and keep listening. */
  cutHeard(range: TextRange): void;
} = {
  start: (botId, range) => controls?.start(botId, range),
  stop: () => controls?.stop(),
  discard: () => controls?.discard(),
  commit: () => controls?.commit(),
  cutHeard: range => {
    touchLive?.();
    const shown = useComposerDictation.getState().interim;
    const kept = (shown.slice(0, range.start) + shown.slice(range.end)).trim();
    cut = { original: rawInterim.trim(), kept };
    useComposerDictation.setState({ interim: kept });
  },
  noteEdit: (botId, edit) => {
    touchLive?.();
    if (origin?.botId === botId && origin.range) setOrigin({ botId, range: shiftRange(origin.range, edit) });
  },
};

const isElectron = () => /Electron\//.test(navigator.userAgent);

export function ComposerDictationHost() {
  const [status, setStatus] = useState<VoiceStatus>();
  const language = useStore(s => s.bots.find(bot => bot.id === s.selectedBotId)?.voiceLanguage);
  const view = useConfigUI(s => s.view);
  const appSettings = useConfigUI(s => s.appSettings);
  const botSettings = useConfigUI(s => s.botSettings);
  const activeBot = useStore(s => s.bots.some(bot => bot.id === s.selectedBotId));
  const mobileChatOpen = useStore(s => s.mobileChatOpen);
  const compact = useCompactLayout();
  const refreshStatus = () => { voiceApi.status().then(setStatus).catch(() => {}); };
  useEffect(refreshStatus, []);

  const fail = (message: string) => routing.route(to => to.error(message));
  // With no chat on screen (the user clicked out of it), words are saved straight into the draft of the chat
  // they were dictated in, so coming back finds everything that was said.
  const saveToDraft = (botId: string, words: string, range?: TextRange) => {
    const heard = words.trim();
    if (!heard) return;
    setDraft(botId, insertDictated(getDraft(botId), heard, range).value);
    flushDrafts();
  };
  const insertRecorded = (heard: string) => {
    const text = filterHeard(heard);
    cut = undefined;
    const began = origin;
    setOrigin(undefined);
    if (!chatTarget() && began) { saveToDraft(began.botId, text, began.range); return; }
    routing.route(to => to.insert(text, began?.botId === to.botId ? began.range : undefined));
  };
  // Live words land at the anchor, which then moves to just after them so the next words follow on.
  const deliverWords = (heard: string) => {
    const words = filterHeard(heard);
    cut = undefined;
    const began = origin;
    if (!chatTarget() && began) {
      saveToDraft(began.botId, words, began.range);
      return;
    }
    routing.route(to => {
      const range = origin?.botId === to.botId ? origin.range : undefined;
      const caret = to.words(words, range);
      if (range && caret !== undefined) setOrigin({ botId: to.botId, range: { start: caret, end: caret } });
    });
  };
  const recorded = useDictation(insertRecorded, fail, language, 10 * 60_000, status?.nativeSpeech);
  const spoken = useLiveDictation(deliverWords, fail, language);

  touchLive = spoken.touch;
  const state = spoken.state !== 'idle' ? spoken.state : recorded.state;
  rawInterim = spoken.interim || recorded.interim;
  const interim = filterHeard(rawInterim);
  useLayoutEffect(() => {
    useComposerDictation.setState(chatTarget() ? { state, interim } : { state: 'idle', interim: '' });
    if (state === 'idle') { setOrigin(undefined); cut = undefined; } // the anchor lives only as long as the dictation does
  }, [state, interim]);

  useLayoutEffect(() => {
    controls = {
      start(botId, range) {
        if (chatTarget() !== botId) return;
        refreshStatus(); // pick up speech settings changed since the last chat box opened
        const audioInput = microphoneId();
        const server = status?.localSpeech || status?.realtime;
        const preferServer = status?.localSpeech || (server && (audioInput || isElectron()));
        // Dictation only ever adds words: a selection becomes a caret after it, and the live words appear right there.
        const anchor = range && { start: range.end, end: range.end };
        if (!preferServer && !isElectron() && supportsLiveDictation(audioInput)) {
          setOrigin({ botId, range: anchor });
          playDictationSound(true);
          void spoken.start(audioInput);
          return;
        }
        if (server) {
          setOrigin({ botId, range: anchor });
          void recorded.begin();
          return;
        }
        fail(audioInput
          ? 'This browser needs a speech server for the selected input. Choose System default or set up speech in Settings → Audio.'
          : 'Set up a speech provider in Settings → Audio.');
      },
      stop() {
        if (spoken.state === 'recording') playDictationSound(false);
        spoken.stop();
        recorded.finish();
      },
      discard() {
        setOrigin(undefined);
        routing.clear();
        spoken.stop(true);
        recorded.finish(true);
      },
      commit() {
        // Live words (finished and still being heard) are delivered now; a recording is sent for transcription and
        // its text is saved into the draft when it arrives.
        spoken.commit();
        recorded.finish();
      },
    };
    return () => { controls = undefined; };
  });

  // Leaving chat saves what was dictated (including the words still being heard) and releases the mic.
  // A bot-to-bot switch does neither: dictation carries on into the chat you switched to.
  useLayoutEffect(() => {
    if (!activeBot || view !== 'chat' || appSettings || botSettings || (compact && !mobileChatOpen)) {
      controls?.commit();
      useComposerDictation.setState({ state: 'idle', interim: '' });
    }
  }, [activeBot, view, appSettings, botSettings, compact, mobileChatOpen]);

  useEffect(() => useStore.subscribe((current, previous) => {
    if (current.selectedBotId !== previous.selectedBotId) setOrigin(undefined);
  }), []);

  return null;
}
