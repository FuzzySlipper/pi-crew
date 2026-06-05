/**
 * InstanceFactory — creates {@link AgentInstance} from a profile.
 *
 * Loads the profile from pi-profiles, creates a provider client,
 * builds the tool registry, and assembles the system prompt template.
 *
 * In the initial v1 implementation (this task), the factory creates
 * minimal instances with identity only.  Full provider/tool/prompt
 * assembly is wired in follow-up tasks.
 *
 * @module pi-service/instances/instance-factory
 */

import type { Logger } from "@pi-crew/core";
import type { AgentInstance } from "./agent-instance.js";
import { AgentInstanceImpl } from "./agent-instance.js";

// ── InstanceFactory interface ───────────────────────────────────

/**
 * Creates {@link AgentInstance} from a profile definition.
 */
export interface InstanceFactory {
  /**
   * Create a new instance from the named profile.
   *
   * @param profileId — Profile name to load from pi-profiles.
   * @param role — Optional worker role hint.
   * @returns A fresh, undisposed instance.
   */
  create(profileId: string, role?: string): Promise<AgentInstance>;
}

// ── InstanceFactoryImpl ─────────────────────────────────────────

/**
 * Default {@link InstanceFactory} implementation.
 *
 * Loads profiles from `@pi-crew/profiles` and creates instances.
 * In v1 the instance is a container for identity + profile metadata;
 * full provider/tool/prompt wiring follows in later tasks.
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
