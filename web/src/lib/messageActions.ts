import { create } from 'zustand';

/** What the Composer quotes while the user writes a reply (Message menu → Reply). */
export interface ReplyTarget { seq: number; name: string; text: string }
/** A message waiting for the user to pick where to send it (Message menu → Forward). */
export interface ForwardDraft { fromBotId: string; fromName: string; text: string }

interface MessageActions {
  replies: Record<string, ReplyTarget | undefined>;
  forward: ForwardDraft | null;
  setReply(botId: string, target: ReplyTarget | null): void;
  setForward(draft: ForwardDraft | null): void;
}

export const useMessageActions = create<MessageActions>((set) => ({
  replies: {},
  forward: null,
  setReply: (botId, target) => set((s) => ({ replies: { ...s.replies, [botId]: target ?? undefined } })),
  setForward: (forward) => set({ forward }),
}));

/** One line of a message for the quote bar and quote bubbles. */
export const quoteText = (text: string, max = 140) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
