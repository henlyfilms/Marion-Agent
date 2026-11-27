// Chat-box dictation that outlives the chat box it started in, and stays locked to that chat.
//
// The two dictation engines (recorded + live) live in <ComposerDictationHost/>, mounted once for the whole workspace,
// so switching chats, opening Settings or clicking any button, tab, drawer or modal never pauses or stops them.
// Dictation belongs to the chat it was started in (its "owner") until the user explicitly stops it: every word goes
// into that chat's box when it is on screen, or straight into that chat's saved draft when it is not — never into
// another chat.
import { useEffect, useLayoutEffect, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { voiceApi, type VoiceStatus } from './api';
import { microphoneId } from './audio';
import { useDictation, type DictationState } from './dictation';
import { supportsLiveDictation, useLiveDictation } from './liveDictation';
import { playDictationSound, primeAudio } from './sounds';
import { createDictationRouter } from './dictationRouting';

import { getDraft, setDraft, flushDrafts } from '../lib/drafts';
import { applyCut, freezeCut, insertDictated, shiftRange, skipWords, type HeardCut, type TextEdit, type TextRange } from './dictationText';
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
interface DictationView { state: DictationState; interim: string; anchor?: DictationAnchor; owner?: string }
/** What every chat box shows: whether dictation is running, the words heard so far and where they belong. */
export const useComposerDictation = create<DictationView>(() => ({ state: 'idle', interim: '' }));

interface Controls {
  start(botId: string, range?: TextRange): void;
  stop(): void;
  discard(): void;
  /** End dictation now and keep every word heard (finished and still being heard) in its own chat. */
  commit(): void;
}

let controls: Controls | undefined;
/** The chat dictation was started in: it receives every word until the user stops dictation. */
let owner: string | undefined;
function setOwner(next: string | undefined) {
  owner = next;
  if (useComposerDictation.getState().owner !== next) useComposerDictation.setState({ owner: next });
}
/** The chat the running dictation belongs to (undefined when idle). */
export const dictationOwner = () => owner;
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

const routing = createDictationRouter<DictationSink>();
export const registerDictationSink = routing.register;

/** Adds dictated words to a chat's saved draft (its box is not on screen). Returns the caret right after them. */
export function saveToDraft(botId: string, words: string, range?: TextRange) {
  const heard = words.trim();
  if (!heard) return range?.end;
  const placed = insertDictated(getDraft(botId), heard, range);
  setDraft(botId, placed.value);
  flushDrafts();
  return placed.caret;
}

export const composerDictation: Controls & {
  /** The user typed or deleted text. Dictation keeps running; only its insertion point follows the edit. */
  noteEdit(botId: string, edit: TextEdit): void;
  /** The user deleted `range` of the words still being heard: drop them for good and keep listening. */
  cutHeard(range: TextRange): void;
  /**
   * The user typed inside, right after or past the words still being heard, or put the caret inside them. Those words are
   * now ordinary text in the box: stop showing them, never add them a second time, and carry on dictating at `anchor`.
   */
  freeze(botId: string, anchor: number): void;
} = {
  start: (botId, range) => controls?.start(botId, range),
  stop: () => controls?.stop(),
  discard: () => controls?.discard(),
  commit: () => controls?.commit(),
  cutHeard: range => {
    touchLive?.();
    const shown = useComposerDictation.getState().interim;
    const kept = (shown.slice(0, range.start) + shown.slice(range.end)).trim();
    // `kept` is what is shown, which already has any frozen words dropped; keep dropping them if the engine revises its text.
    cut = { original: skipWords(rawInterim, cut?.skip ?? 0), kept, skip: cut?.skip };
    useComposerDictation.setState({ interim: kept });
  },
  freeze: (botId, anchor) => {
    touchLive?.();
    const shown = useComposerDictation.getState().interim;
    if (!shown.trim()) { setOrigin(origin?.botId === botId ? { botId, range: { start: anchor, end: anchor } } : origin); return; }
    cut = freezeCut(cut, shown);
    setOrigin({ botId, range: { start: anchor, end: anchor } });
    useComposerDictation.setState({ interim: '' });
  },
  noteEdit: (botId, edit) => {
    touchLive?.();
    if (origin?.botId === botId && origin.range) setOrigin({ botId, range: shiftRange(origin.range, edit) });
  },
};

const isElectron = () => /Electron\//.test(navigator.userAgent);

export function ComposerDictationHost() {
  const [status, setStatus] = useState<VoiceStatus>();
  const dictatingIn = useComposerDictation(s => s.owner);
  const language = useStore(s => s.bots.find(bot => bot.id === (dictatingIn ?? s.selectedBotId))?.voiceLanguage);
  const refreshStatus = () => { voiceApi.status().then(setStatus).catch(() => {}); };
  useEffect(refreshStatus, []);

  const fail = (message: string) => (routing.sinkFor(owner ?? '') ?? routing.latest())?.error(message);
  // Words go only to the chat dictation was started in: into its box when on screen, else into its saved draft, so
  // coming back finds everything that was said. The chat on screen never receives another chat's words.
  const insertRecorded = (heard: string) => {
    const text = filterHeard(heard);
    cut = undefined;
    const began = origin;
    const target = owner ?? began?.botId;
    setOrigin(undefined);
    const range = began?.botId === target ? began?.range : undefined;
    routing.deliver(target, to => to.insert(text, range), botId => { saveToDraft(botId, text, range); });
  };
  // Live words land at the anchor, which then moves to just after them so the next words follow on.
  const deliverWords = (heard: string) => {
    const words = filterHeard(heard);
    cut = undefined;
    const target = owner ?? origin?.botId;
    const range = origin?.botId === target ? origin?.range : undefined;
    const follow = (botId: string, caret: number | undefined) => {
      if (range && caret !== undefined) setOrigin({ botId, range: { start: caret, end: caret } });
    };
    routing.deliver(target, to => follow(to.botId, to.words(words, range)), botId => follow(botId, saveToDraft(botId, words, range)));
  };
  const recorded = useDictation(insertRecorded, fail, language, 10 * 60_000, status?.nativeSpeech, () => {
    const botId = owner ?? origin?.botId;
    return botId ? getDraft(botId) : '';
  });
  const spoken = useLiveDictation(deliverWords, fail, language);

  touchLive = spoken.touch;
  const state = spoken.state !== 'idle' ? spoken.state : recorded.state;
  rawInterim = spoken.interim || recorded.interim;
  const interim = filterHeard(rawInterim);
  useLayoutEffect(() => {
    // Published whatever is on screen: each chat box shows the words only when it is the owner (see Composer).
    useComposerDictation.setState({ state, interim });
    // The owner and anchor live exactly as long as the dictation does.
    if (state === 'idle') { setOrigin(undefined); setOwner(undefined); cut = undefined; }
  }, [state, interim]);

  useLayoutEffect(() => {
    controls = {
      start(botId, range) {
        primeAudio(); // inside the click: lets the start cue and the listening bars run every time
        if (chatTarget() !== botId || owner) return; // one dictation at a time, started from the chat on screen
        refreshStatus(); // pick up speech settings changed since the last chat box opened
        const audioInput = microphoneId();
        const server = status?.localSpeech || status?.realtime;
        const preferServer = status?.localSpeech || (server && (audioInput || isElectron()));
        // Dictation only ever adds words: a selection becomes a caret after it, and the live words appear right there.
        const anchor = range && { start: range.end, end: range.end };
        if (!preferServer && !isElectron() && supportsLiveDictation(audioInput)) {
          setOwner(botId);
          setOrigin({ botId, range: anchor });
          playDictationSound(true);
          void spoken.start(audioInput);
          return;
        }
        if (server) {
          setOwner(botId);
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

  // Switching chats, opening Settings, a drawer, a modal or another view never pauses or stops dictation: it keeps
  // writing into its own chat until the user stops it. Only a deleted owner chat ends it (keeping nothing to save).
  useEffect(() => useStore.subscribe(current => {
    if (owner && !current.bots.some(bot => bot.id === owner)) controls?.discard();
  }), []);

  return null;
}
