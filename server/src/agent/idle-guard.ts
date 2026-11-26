/**
 * Silence watchdog for relayed Claude / Codex / Gemini runs.
 *
 * A relayed session may legitimately run for hours (a big refactor, a long test run), so there is no wall-clock
 * limit. The only safeguard is for a CLI that has gone completely silent: no stdout, no stderr and no protocol
 * message for `idleMs`. Every sign of life calls `touch()`, which restarts the clock.
 */
export class IdleGuard {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private done = false;
  tripped = false;

  constructor(readonly idleMs: number) {
    this.signal = this.controller.signal;
    this.arm();
  }

  private arm() {
    if (this.done) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.done) return;
      this.tripped = true;
      this.controller.abort(new Error('idle'));
    }, this.idleMs);
    this.timer.unref?.();
  }

  /** The run showed a sign of life: output, a step, an event. */
  touch() { this.arm(); }

  /** The run is over: stop watching. */
  stop() { this.done = true; clearTimeout(this.timer); }
}

/** How long a relayed run may stay completely silent before it is treated as hung (MARION_RELAY_IDLE_MS overrides). */
export function relayIdleMs(inFolder: boolean) {
  const override = Number(process.env.MARION_RELAY_IDLE_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return inFolder ? 30 * 60_000 : 10 * 60_000;
}

export function silenceMessage(label: string, idleMs: number, diagnostic: string) {
  const mins = idleMs >= 60_000 ? `${Math.round(idleMs / 60_000)} minutes` : `${Math.round(idleMs / 1000)} seconds`;
  const detail = diagnostic.trim().slice(-400);
  return `${label} stopped responding: it sent no output for ${mins}.${detail ? ` Last message: ${detail}` : ''} Try again.`;
}
