import { useLayoutEffect, useRef } from 'react';
import { matchLabel, isBlankQuery } from '../lib/chatSearch';
import { closeChatSearch, useChatSearch } from '../lib/chatSearchStore';
import { Icon } from './Icon';

/** Floating search bar at the top right of the chat. Always mounted so it can animate out as well as in. */
export function ChatSearchBar() {
  const open = useChatSearch(s => s.open);
  const query = useChatSearch(s => s.query);
  const active = useChatSearch(s => s.active);
  const count = useChatSearch(s => s.count);
  const focusTick = useChatSearch(s => s.focusTick);
  const input = useRef<HTMLInputElement>(null);

  // Opening, or Cmd/Ctrl+F while already open: focus the box and select what is in it.
  useLayoutEffect(() => {
    if (!focusTick) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [focusTick]);

  const { setQuery, step } = useChatSearch.getState();
  const blank = isBlankQuery(query);
  const noMatches = !blank && count === 0;
  return (
    <div
      className={`chat-search${open ? ' is-open' : ''}`}
      role="search"
      aria-label="Search in this chat"
      aria-hidden={!open}
      ref={node => { if (node) node.inert = !open; }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChatSearch(); }
      }}
    >
      <Icon name="search" size={15} opacity={0.56} className="chat-search__icon" />
      <input
        ref={input}
        className="chat-search__input"
        type="text"
        value={query}
        placeholder="Search in chat"
        aria-label="Search in chat"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
        }}
      />
      <span className={`chat-search__count${noMatches ? ' is-empty' : ''}${blank ? ' is-idle' : ''}`} role="status" aria-live="polite">
        {matchLabel(query, active, count)}
      </span>
      <button type="button" className="chat-search__btn" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={count === 0} onClick={() => step(-1)}>
        <Icon name="arrow_up" size={15} />
      </button>
      <button type="button" className="chat-search__btn" aria-label="Next match" title="Next match (Enter)" disabled={count === 0} onClick={() => step(1)}>
        <Icon name="arrow_down" size={15} />
      </button>
      <button type="button" className="chat-search__btn" aria-label="Close search" title="Close (Esc)" onClick={closeChatSearch}>
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
