/**
 * AgentInstance — a runtime entity bound to exactly one session.
 *
 * Holds warmed resources (provider client, tool registry) and is
 * disposed when the session ends or the idle timeout fires.
 *
 * @module pi-service/instances/agent-instance
 */

// ── AgentInstance interface ─────────────────────────────────────

/**
 * A runtime agent entity created from a profile.
 *
 * Each instance belongs to exactly one session (1:1 binding).
 * Instances are never shared, never pooled across sessions.
 */
export interface AgentInstance {
  /** Unique instance identifier (UUID). */
  readonly id: string;

  /** Profile ID this instance was created from. */
  readonly profileId: string;

  /** When the instance was created. */
  readonly createdAt: Date;

  /** Whether the instance has been disposed. */
  readonly isDisposed: boolean;

  /**
   * Release all resources held by this instance.
   *
   * Idempotent — safe to call multiple times. After disposal the
   * instance should not be used.
   */
  dispose(): Promise<void>;
}

// ── AgentInstance implementation ────────────────────────────────

let instanceCounter = 0;

/**
 * Default {@link AgentInstance} implementation.
 *
 * In the initial v1 implementation the instance holds only identity
 * fields and a disposal flag.  Full provider-client and tool-registry
 * wiring happens in follow-up tasks.
 */
export class AgentInstanceImpl implements AgentInstance {
  public readonly id: string;
  public readonly createdAt: Date;
  private _disposed = false;

  constructor(public readonly profileId: string, id?: string) {
    instanceCounter += 1;
    this.id = id ?? `inst-${String(instanceCounter)}-${String(Date.now())}`;
    this.createdAt = new Date();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  dispose(): Promise<void> {
    this._disposed = true;
    return Promise.resolve();
  }
}
