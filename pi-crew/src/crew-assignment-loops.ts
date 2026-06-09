import type { Logger } from "@pi-crew/core";
import { createDenAssignmentLoop, type DenAssignmentLoop } from "./den-assignment-loop.js";
import type { DenAssignmentRunner } from "./den-assignment-runner.js";
import type { DenPoolMemberConfig } from "./den-pool-source.js";

export interface CrewAssignmentLoopSource {
  createDenAssignmentRunner(member: DenPoolMemberConfig): DenAssignmentRunner;
}

export interface CrewAssignmentLoopsConfig {
  readonly crew: CrewAssignmentLoopSource;
  readonly members: readonly DenPoolMemberConfig[];
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly shouldAcceptWork?: () => boolean;
}

export function createCrewAssignmentLoops(config: CrewAssignmentLoopsConfig): DenAssignmentLoop[] {
  return config.members.map((member) =>
    createDenAssignmentLoop({
      workerIdentity: member.workerIdentity,
      runner: config.crew.createDenAssignmentRunner(member),
      pollIntervalMs: config.pollIntervalMs,
      logger: config.logger,
      shouldAcceptWork: config.shouldAcceptWork,
    }),
  );
}
