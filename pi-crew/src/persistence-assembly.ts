/**
 * Persistence assembly builder — all DB-backed repository services.
 *
 * Second in the dependency chain: requires infra for config and logger.
 *
 * @module pi-crew/persistence-assembly
 */

import type { Logger, AgentWorkBreadcrumbRepository } from "@pi-crew/core";
import {
  RuntimeDb,
  SqliteSessionRepository,
  SqliteMessageRepository,
  SqliteAuditRepository,
  SqliteAgentWorkBreadcrumbRepository,
  PublishingAgentWorkBreadcrumbRepository,
  HttpAgentWorkLifecyclePublisher,
  SqliteCounterRepository,
  DefaultCounterService,
  SqliteDenseProfileMemoryStore,
  SqliteCronJobRepository,
  SqlitePendingChildRepository,
  type CounterService,
  type CronJobRepository,
} from "@pi-crew/service";
import type { CursorStore } from "@pi-crew/channels/den-channels/connection-types";
import { createSqliteCursorStore } from "./den-connection-factory.js";
import type { InfraAssembly } from "./infra-assembly.js";
import { resolveCrewInstallLayout } from "./config.js";

export interface PersistenceAssembly {
  readonly runtimeDb: RuntimeDb;
  readonly sessionStore: SqliteSessionRepository;
  readonly auditRepository: SqliteAuditRepository;
  readonly agentWorkBreadcrumbRepository: AgentWorkBreadcrumbRepository;
  readonly messageRepository: SqliteMessageRepository;
  readonly counterService: CounterService;
  readonly denseMemoryStore: SqliteDenseProfileMemoryStore;
  readonly cronRepository: CronJobRepository;
  readonly pendingChildRepository: SqlitePendingChildRepository;
  readonly cursorStore: CursorStore;
}

export function setupPersistence(
  infra: InfraAssembly,
): PersistenceAssembly {
  const { config, logger } = infra;

  const runtimeDb = new RuntimeDb(config.database, logger);
  const sessionStore = new SqliteSessionRepository(runtimeDb.handle, logger);
  const messageRepository = new SqliteMessageRepository(runtimeDb.handle);
  const auditRepository = new SqliteAuditRepository(runtimeDb.handle);

  const sqliteAgentWorkBreadcrumbRepository = new SqliteAgentWorkBreadcrumbRepository(runtimeDb.handle);
  const agentWorkBreadcrumbRepository: AgentWorkBreadcrumbRepository =
    new PublishingAgentWorkBreadcrumbRepository({
      inner: sqliteAgentWorkBreadcrumbRepository,
      publisher: new HttpAgentWorkLifecyclePublisher({
        baseUrl: config.den.channelsUrl,
        token: config.den.channelsToken,
        logger,
      }),
      logger,
    });

  const counterService = new DefaultCounterService(
    new SqliteCounterRepository(runtimeDb.handle),
  );

  const denseMemoryStore = new SqliteDenseProfileMemoryStore(
    runtimeDb.handle,
    logger,
    resolveCrewInstallLayout(config).profilesRoot,
  );

  const cronRepository = new SqliteCronJobRepository(runtimeDb.handle);
  const pendingChildRepository = new SqlitePendingChildRepository(runtimeDb.handle);
  const cursorStore = createSqliteCursorStore(runtimeDb);

  return {
    runtimeDb,
    sessionStore,
    auditRepository,
    agentWorkBreadcrumbRepository,
    messageRepository,
    counterService,
    denseMemoryStore,
    cronRepository,
    pendingChildRepository,
    cursorStore,
  };
}
