/** Host-wide admission accounting for every retained terminal screen and follower queue. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Bytes charged per retained screen cell. xterm's headless buffer keeps one code
 * point per cell in a `Uint32Array`, so four bytes is the floor of one cell's
 * cost; attribute and hyperlink tables add a bounded amount on top that this
 * estimate deliberately ignores, because a budget only has to be proportional
 * and monotone in what it protects.
 */
const SCREEN_BYTES_PER_CELL = 4

/** Which bounded buffer one charge covers; carried into the refusal's diagnostics. */
export type TerminalChargePurpose = 'terminal' | 'follower'

/** One admission against a {@link TerminalBudget}, refunded exactly once. */
export interface TerminalCharge {
  /** Refund the reserved bytes; every later call is a no-op. */
  release(): void
}

/** The Host-wide budget plus the screen charge one terminal already holds. */
export interface TerminalBufferLimits {
  /** Ceiling every screen and follower queue of this terminal charges against. */
  readonly budget: TerminalBudget
  /** This terminal's screen admission, refunded when its screen is disposed. */
  readonly screen: TerminalCharge
}

/**
 * Ceiling on the buffers every Session's terminals may reserve together. A
 * request that would cross the ceiling is refused, and nothing already running
 * or attached is reclaimed to make room: the Host cannot tell a shell that is
 * thinking from one that was abandoned, so eviction would kill live work while
 * a refusal only delays a new tab. Automatic reclamation stays where it can be
 * evidenced — {@link TerminalRetention}'s confirmed idle timeout.
 *
 * Reservations are worst case rather than measured: a terminal holds its screen
 * at the widest geometry the deployment permits, and a follower holds its whole
 * queue, so the total never depends on when it is sampled.
 */
export class TerminalBudget {
  private used = 0

  /** @param maxBytes - bytes every screen and follower queue may reserve together. */
  constructor(private readonly maxBytes: number) {}

  /**
   * Worst-case bytes one retained screen reserves at the widest permitted geometry:
   * the charge is taken once, before the screen can grow, so a terminal can never
   * admit a screen the budget would have refused at its full size.
   * @param scrollback - retained scrollback rows the screen's buffer may hold.
   * @param maxCols - widest column count the deployment lets a screen reach.
   * @returns worst-case bytes to reserve for that screen, released when it is disposed.
   */
  static screen(scrollback: number, maxCols: number): number { return scrollback * maxCols * SCREEN_BYTES_PER_CELL }

  /** Bytes reserved right now; diagnostics only. */
  get reserved(): number { return this.used }

  /**
   * Reserve one bounded buffer, or refuse the request without touching anything reserved.
   * @param bytes - worst-case size of the buffer being admitted.
   * @param purpose - which buffer the charge covers; names the refusal's cause.
   * @returns the admission, to be released exactly when that buffer is gone.
   */
  reserve(bytes: number, purpose: TerminalChargePurpose): TerminalCharge {
    if (this.used + bytes > this.maxBytes) {
      throw new RemoteError('terminal/capacity-reached', `Host-wide terminal buffer capacity reached while opening a new ${purpose}`, {
        limit: this.maxBytes, used: this.used, requested: bytes, purpose,
      })
    }
    this.used += bytes
    let released = false
    return { release: () => { if (released) return; released = true; this.used -= bytes } }
  }
}
