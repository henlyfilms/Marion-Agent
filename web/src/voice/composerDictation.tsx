// Chat-box dictation that outlives the chat it started in.
//
// The two dictation engines (recorded + live) used to live inside each chat's Composer, which is re-created on
// every chat switch, so switching chats cut dictation off. They now live in <ComposerDictationHost/>, mounted once
// for the whole workspace. Whichever Composer is on screen registers itself as the "sink" for dictated words, so
// when you switch chats the recording keeps going and the words land in the chat you switched to.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export interface TextRange { start: number; end: number }

/** The chat box currently on screen: where dictated words go. */
export interface DictationSink {
  botId: string;
  /** Finished transcription from the speech server, inserted at `range` (where the caret was when it started). */
  insert(text: string, range?: TextRange): void;
  /** Final words from live (browser) dictation, appended at the end. */
  words(words: string): void;
  error(message: string): void;
}

interface DictationView { state: DictationState; interim: string }
/** What every chat box shows: whether dictation is running and the words heard so far. */
export const useComposerDictation = create<DictationView>(() => ({ state: 'idle', interim: '' }));

interface Controls {
  start(botId: string, range?: TextRange): void;
  stop(): void;
  discard(): void;
}

let controls: Controls | undefined;

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

export const composerDictation: Controls = {
  start: (botId, range) => controls?.start(botId, range),
  stop: () => controls?.stop(),
  discard: () => controls?.discard(),
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
  /** Where a recorded dictation began, so its caret position is only reused in that same chat. */
  const origin = useRef<{ botId: string; range?: TextRange }>();
  const refreshStatus = () => { voiceApi.status().then(setStatus).catch(() => {}); };
  useEffect(refreshStatus, []);

  const fail = (message: string) => routing.route(to => to.error(message));
  const insertRecorded = (text: string) => {
    const began = origin.current;
    origin.current = undefined;
    routing.route(to => to.insert(text, began?.botId === to.botId ? began.range : undefined));
  };
  const deliverWords = (words: string) => routing.route(to => to.words(words));
  const recorded = useDictation(insertRecorded, fail, language, 10 * 60_000, status?.nativeSpeech);
  const spoken = useLiveDictation(deliverWords, fail, language);

  const state = spoken.state !== 'idle' ? spoken.state : recorded.state;
  const interim = spoken.interim || recorded.interim;
  useLayoutEffect(() => {
    useComposerDictation.setState(chatTarget() ? { state, interim } : { state: 'idle', interim: '' });
  }, [state, interim]);

  useLayoutEffect(() => {
    controls = {
      start(botId, range) {
        if (chatTarget() !== botId) return;
        refreshStatus(); // pick up speech settings changed since the last chat box opened
        const audioInput = microphoneId();
        const server = status?.localSpeech || status?.realtime;
        const preferServer = status?.localSpeech || (server && (audioInput || isElectron()));
        if (!preferServer && !isElectron() && supportsLiveDictation(audioInput)) {
          playDictationSound(true);
          void spoken.start(audioInput);
          return;
        }
        if (server) {
          origin.current = { botId, range };
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
        origin.current = undefined;
        routing.clear();
        spoken.stop(true);
        recorded.finish(true);
      },
    };
    return () => { controls = undefined; };
  });

  // Leaving chat cancels uncommitted speech and releases the mic. A bot-to-bot switch does neither.
  useLayoutEffect(() => {
    if (!activeBot || view !== 'chat' || appSettings || botSettings || (compact && !mobileChatOpen)) {
      controls?.discard();
      useComposerDictation.setState({ state: 'idle', interim: '' });
    }
  }, [activeBot, view, appSettings, botSettings, compact, mobileChatOpen]);

  useEffect(() => useStore.subscribe((current, previous) => {
    if (current.selectedBotId !== previous.selectedBotId) origin.current = undefined;
  }), []);

  return null;
}
