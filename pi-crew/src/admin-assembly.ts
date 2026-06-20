/**
 * Admin assembly builder — admin server, debug services, remediation
 * control, and tool inventory.
 *
 * Sixth and last in the dependency chain. Returns null if admin is disabled.
 *
 * @module pi-crew/admin-assembly
 */

import {
  AdminServer,
  DirectDebugSessionService,
  DirectDebugContextService,
  RemediationControlService,
  FullSessionResetService,
  type ExtensionConfigReloadOutcome,
} from "@pi-crew/service";
import { loadProfile } from "@pi-crew/profiles";
import { validateCrewConfig } from "./crew-helpers.js";
import { resolveCrewInstallLayout } from "./config.js";
import { createDenAdminEvidencePoster } from "./den-admin-evidence-poster.js";
import { resolveFullAgentRuntime } from "./full-agent-runtime-assembly.js";
import type { McpSurfaceManager } from "./mcp-surface-manager.js";
import type { InfraAssembly } from "./infra-assembly.js";
import type { PersistenceAssembly } from "./persistence-assembly.js";
import type { McpAssembly } from "./mcp-assembly.js";
import type { RoutingAssembly } from "./routing-assembly.js";

export interface AdminAssembly {
  readonly adminServer: AdminServer | null;
}

export interface AdminAssemblyDeps {
  readonly infra: InfraAssembly;
  readonly persistence: PersistenceAssembly;
  readonly mcp: McpAssembly;
  readonly routing: RoutingAssembly;
  readonly mcpSurfaceManager: McpSurfaceManager;
  readonly reloadConfig: (candidateConfig: unknown) => Promise<ExtensionConfigReloadOutcome>;
}

export function setupAdmin(deps: AdminAssemblyDeps): AdminAssembly {
  const { infra, persistence, mcp, routing, mcpSurfaceManager, reloadConfig } = deps;
  const { config, gatewayConfig, logger, eventBus } = infra;
  const { sessionStore, messageRepository, auditRepository } = persistence;
  const { mcpClient, diagnostics } = mcp;
  const { sessionManager, instancePool } = routing;

  if (!config.admin.enabled) {
    return { adminServer: null };
  }

  const sessionResetService = new FullSessionResetService({
    sessionStore,
    instancePool,
    messageRepository,
    eventBus,
  });

  const adminServer = new AdminServer({
    config: gatewayConfig.admin,
    diagnostics,
    directDebug: new DirectDebugSessionService({
      sessionManager,
      diagnostics,
      resetSession: (request) => sessionResetService.reset(request),
      reloadMcp: (request) =>
        mcpSurfaceManager.reloadForProfile(
          loadProfile(request.profileId, resolveCrewInstallLayout(config).profilesRoot),
          request,
        ),
    }),
    debugContext: new DirectDebugContextService({
      diagnostics,
      messages: messageRepository,
    }),
    controls: new RemediationControlService({
      diagnostics,
      auditRepository,
      eventBus,
      sessionStore,
      instancePool,
      evidencePoster: createDenAdminEvidencePoster({
        mcpClient,
        projectId: config.agent.projectId,
        sender: config.agent.identity,
        logger,
      }),
      validateConfig: (raw: unknown) => {
        const crew = validateCrewConfig(raw);
        if (!crew.valid) return crew;
        try {
          const { loadConfig } = require("@pi-crew/service") as typeof import("@pi-crew/service");
          loadConfig(raw);
          return { valid: true, errors: [] };
        } catch (error: unknown) {
          return {
            valid: false,
            errors: [error instanceof Error ? error.message : String(error)],
          };
        }
      },
      reloadConfig,
    }),
    toolInventory: {
      projectTools: (sessionId: string | undefined): Promise<unknown> => {
        const profilesRoot = resolveCrewInstallLayout(config).profilesRoot;
        const agents = config.fullAgents.filter((agent) =>
          sessionId === undefined ? agent.enabled : agent.session?.sessionId === sessionId,
        );
        return Promise.resolve({
          inventories: agents.map((agent) =>
            resolveFullAgentRuntime({
              agent,
              profilesRoot,
              mcpSurfaceManager,
              logger,
              defaultDenProjectId: config.den.channelsProjectId,
            }).inventory
          ),
        });
      },
    },
    agentWorkBreadcrumbs: persistence.agentWorkBreadcrumbRepository,
  });

  return { adminServer };
}
