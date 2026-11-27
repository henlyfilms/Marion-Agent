// Chat-locked dictation delivery. Words always go to the chat dictation was started in (its owner), never to the
// chat that happens to be on screen: when that chat's box is mounted the words go into it, otherwise they are saved
// straight into its draft so switching chats, opening Settings or any drawer/modal never moves or drops them.
export function createDictationRouter<Sink extends { botId: string }>() {
  /** Every mounted chat box, newest last (an outgoing and an incoming box can briefly be mounted together). */
  const sinks: Sink[] = [];
  const sinkFor = (botId: string) => {
    for (let index = sinks.length - 1; index >= 0; index--) if (sinks[index].botId === botId) return sinks[index];
    return undefined;
  };
  return {
    sinkFor,
    /** The newest mounted chat box, whichever chat it belongs to (for errors when the owner's box is not on screen). */
    latest: () => sinks[sinks.length - 1],
    /** Delivers to `owner`'s mounted box, or to `offScreen(owner)` (its saved draft) when that box is not mounted. */
    deliver(owner: string | undefined, toSink: (sink: Sink) => void, offScreen: (botId: string) => void) {
      if (!owner) return;
      const sink = sinkFor(owner);
      if (sink) toSink(sink);
      else offScreen(owner);
    },
    register(next: Sink) {
      sinks.push(next);
      return () => {
        const index = sinks.lastIndexOf(next);
        if (index >= 0) sinks.splice(index, 1);
      };
    },
  };
}
