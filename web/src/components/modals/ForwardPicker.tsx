import { useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { quoteText, useMessageActions } from '../../lib/messageActions';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { openBotChat } from '../botMenuItems';
import { Modal } from './Modal';

/** Message menu → Forward…: pick another Bot or an existing group chat to send the message to. */
export function ForwardPicker() {
  const draft = useMessageActions((s) => s.forward);
  const bots = useStore((s) => s.bots);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => useMessageActions.getState().setForward(null);
  if (!draft) return null;

  const others = bots.filter((b) => b.id !== draft.fromBotId);
  const groups = others.filter((b) => b.kind === 'room');
  const agents = others.filter((b) => b.kind !== 'room');

  const forward = async (targetId: string) => {
    if (busy) return;
    setBusy(targetId); setError(null);
    try {
      await api.send(targetId, draft.text, [], { forwardedFrom: draft.fromName });
      close();
      openBotChat(targetId);
    } catch (e) {
      setError((e as Error).message || 'Could not forward the message');
      setBusy(null);
    }
  };

  const section = (title: string, list: typeof bots) => list.length > 0 && (
    <>
      <div className="section-label" style={{ marginTop: 12 }}>{title}</div>
      <div className="group-pick forward-pick" role="list">
        {list.map((b) => (
          <button key={b.id} type="button" role="listitem" className="group-pick__opt" disabled={!!busy} onClick={() => forward(b.id)}>
            <BotAvatarFor bot={b} size={26} />
            <span className="group-pick__name">{b.name}{b.kind === 'room' ? '' : b.label ? ` · ${b.label}` : ''}</span>
            {busy === b.id && <span className="forward-pick__busy">Sending…</span>}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <Modal onClose={close} className="create-modal" label="Forward message">
      <div className="modal__header">
        <div className="modal__title">Forward to…</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="create-modal__body" style={{ alignItems: 'stretch' }}>
        <div className="forward-preview" aria-label="Message being forwarded">{quoteText(draft.text, 220)}</div>
        {section('Bots', agents)}
        {section('Group chats', groups)}
        {!others.length && <div className="cfg-empty">There are no other chats to forward to yet.</div>}
        {error && <div className="card__error">{error}</div>}
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--secondary btn--sm" onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}
