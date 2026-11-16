/**
 * No-event stall watchdog for one agy prompt turn.
 *
 * "Still working" is any session/update for the session — including thought chunks,
 * usage_update and config updates — or a permission request. Time spent waiting for
 * the user to answer a permission prompt is never counted as agy silence.
 *
 * The watchdog only *reports*: a warning once silence passes `warnAfterMs`, and a
 * stall once it reaches `stallTimeoutMs`. Silence below the limit never ends the turn.
 */
// Silence is not proof of a stalled process. Automatic cancellation is opt-in.
export const AGY_DEFAULT_STALL_TIMEOUT_MS = 0;
export const AGY_DEFAULT_SILENCE_WARNING_MS = 60_000;
export const AGY_MIN_STALL_TIMEOUT_MS = 10_000;
export const AGY_STALL_TIMEOUT_ENV = 'CINDY_AGY_STALL_TIMEOUT_MS';

export interface AgyStallWatchdogOptions {
  /** 0 disables automatic cancellation; status warnings remain enabled. */
  stallTimeoutMs: number;
  /** Defaults to half an explicit limit, or one minute when cancellation is disabled. */
  warnAfterMs?: number;
  onWarn(silentMs: number): void;
  onStall(silentMs: number): void;
  now?: () => number;
  /** Polling granularity; the effective resolution of warn/stall detection. */
  tickMs?: number;
}

/**
 * Resolve the configured limit. Precedence: per-session vendor option, host option, env, default.
 * Invalid values are ignored; `0` disables cancellation, not waiting status or user stop.
 */
export function resolveAgyStallTimeoutMs(...candidates: unknown[]): number {
  for (const candidate of [...candidates, process.env[AGY_STALL_TIMEOUT_ENV]]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const value = typeof candidate === 'string' ? Number(candidate) : candidate;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (value === 0) return 0;
    return Math.min(Math.max(Math.round(value), AGY_MIN_STALL_TIMEOUT_MS), 24 * 60 * 60_000);
  }
  return AGY_DEFAULT_STALL_TIMEOUT_MS;
}

export class AgyStallWatchdog {
  private lastActivity = 0;
  private pausedDepth = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private warned = false;
  private fired = false;
  private readonly now: () => number;

  constructor(private readonly options: AgyStallWatchdogOptions) {
    this.now = options.now ?? Date.now;
  }

  get stallTimeoutMs(): number { return this.options.stallTimeoutMs; }

  start(): void {
    this.stop();
    this.lastActivity = this.now();
    this.pausedDepth = 0;
    this.warned = false;
    this.fired = false;
    const budget = this.options.stallTimeoutMs > 0 ? this.options.stallTimeoutMs : AGY_DEFAULT_SILENCE_WARNING_MS;
    const tick = this.options.tickMs ?? Math.min(5_000, Math.max(250, Math.floor(budget / 20)));
    this.timer = setInterval(() => this.check(), tick);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Any agy activity for this session resets silence. */
  touch(): void {
    this.lastActivity = this.now();
    this.warned = false;
  }

  /** Waiting for the user (e.g. a permission prompt): silence is not agy's. Nestable. */
  pause(): () => void {
    this.pausedDepth++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pausedDepth = Math.max(0, this.pausedDepth - 1);
      this.touch();
    };
  }

  silentMs(): number { return this.now() - this.lastActivity; }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private check(): void {
    if (this.fired || this.pausedDepth > 0) return;
    const silent = this.silentMs();
    const limit = this.options.stallTimeoutMs;
    const warnAt = this.options.warnAfterMs ?? (limit > 0 ? Math.floor(limit / 2) : AGY_DEFAULT_SILENCE_WARNING_MS);
    if (limit > 0 && silent >= limit) {
      this.fired = true;
      this.stop();
      this.options.onStall(silent);
      return;
    }
    if (!this.warned && warnAt > 0 && silent >= warnAt) {
      this.warned = true;
      this.options.onWarn(silent);
    }
  }
}
