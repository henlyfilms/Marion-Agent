// Buffer callbacks only for the chat selected during a Composer hand-off.
export function createDictationRouter<Sink extends { botId: string }>(chatTarget: () => string | undefined) {
  type Delivery = (sink: Sink) => void;
  let sink: Sink | undefined;
  const pending: Array<{ botId: string; deliver: Delivery }> = [];
  return {
    route(deliver: Delivery) {
      const botId = chatTarget();
      if (!botId) return;
      if (sink?.botId === botId) deliver(sink);
      else pending.push({ botId, deliver });
    },
    register(next: Sink) {
      sink = next;
      if (chatTarget() === next.botId) {
        for (const item of pending.splice(0)) {
          if (item.botId === next.botId) item.deliver(next);
        }
      }
      return () => { if (sink === next) sink = undefined; };
    },
    clear() { pending.length = 0; },
  };
}
