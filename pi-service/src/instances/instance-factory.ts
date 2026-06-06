/**
 * InstanceFactory — creates {@link AgentInstance} from a profile id.
 *
 * Construction is profile-id based: the factory receives a profile id and
 * creates an instance carrying that identity. Full profile loading,
 * provider client creation, tool registry assembly, and system prompt
 * construction are wired later by the pi-crew composition root. pi-service
 * intentionally has no direct dependency on pi-profiles while that source
 * boundary is still injected outside the package.
 *
 * @module pi-service/instances/instance-factory
 */

import type { Logger } from "@pi-crew/core";
import type { AgentInstance } from "./agent-instance.js";
import { AgentInstanceImpl } from "./agent-instance.js";

// ── InstanceFactory interface ───────────────────────────────────

/**
 * Creates {@link AgentInstance} from a profile id.
 */
export interface InstanceFactory {
  /**
   * Create a new instance carrying the named profile id.
   *
   * @param profileId — Profile id to attach to the new instance.
   * @param role — Optional worker role hint.
   * @returns A fresh, undisposed instance.
   */
  create(profileId: string, role?: string): Promise<AgentInstance>;
}

// ── InstanceFactoryImpl ─────────────────────────────────────────

/**
 * Default {@link InstanceFactory} implementation.
 *
 * Creates an instance carrying only the profile id. It does NOT load
 * the profile from a filesystem, database, or network source — source
 * lookup belongs to the composition root once a concrete profile source
 * is injected there.
 */
export class InstanceFactoryImpl implements InstanceFactory {
  constructor(private readonly logger: Logger) {}

  create(profileId: string, role?: string): Promise<AgentInstance> {
    // DESIGN: Keep pi-service instance construction profile-id based until the
    // composition root wires a concrete ProfileSource. Rationale: pi-profiles is
    // standalone global configuration; service unit tests use synthetic profile
    // ids and should not require installed profile fixtures.
    this.logger.debug("Creating agent instance", {
      profileId,
      role,
    });

    return Promise.resolve(new AgentInstanceImpl(profileId));
  }
}
