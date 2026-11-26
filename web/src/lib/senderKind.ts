/** Who wrote a chat message, for styling. Only the fields of a message body that matter here. */
export interface SenderInfo { role: 'user' | 'assistant'; from?: { kind: 'bot' | 'routine' | 'voice' | 'model' } }

/** True for text written by another bot (a bot-to-bot message or a bot's reply in a group chat), not the user or this chat's own bot. */
export function isOtherBotMessage(body: SenderInfo): boolean {
  return body.from?.kind === 'bot';
}

/** Extra bubble class for other-bot text; empty for normal user and assistant text. */
export function senderBubbleClass(body: SenderInfo): string {
  return isOtherBotMessage(body) ? ' is-other-bot' : '';
}
