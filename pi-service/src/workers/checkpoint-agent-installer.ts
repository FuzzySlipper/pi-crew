/** Installs request_checkpoint on Agent tool state. */

import type { CheckpointPoster } from "@pi-crew/tools";
import { requestCheckpointTool } from "@pi-crew/tools";
import type { WorkerBinding } from "../sessions/types.js";
import type { AgentLike } from "./agent-supervisor.js";
import type { WorkerCheckpointController } from "./worker-checkpoint-controller.js";

export interface CheckpointToolInstallConfig {
  readonly agent: AgentLike;
  readonly binding: WorkerBinding;
  readonly checkpointState: WorkerCheckpointController;
  readonly checkpointPoster?: CheckpointPoster;
}

const POSTER_NOT_CONFIGURED: CheckpointPoster = async () => ({
  accepted: false,
  message: "checkpoint poster is not configured for this WorkerRuntime",
});

export function installRequestCheckpointTool(config: CheckpointToolInstallConfig): void {
  const state = config.agent.state;
  if (state === undefined) return;
  const poster = config.checkpointPoster ?? POSTER_NOT_CONFIGURED;
  const binding = config.binding;
  const tool = requestCheckpointTool({
    assignmentId: binding.assignmentId,
    runId: binding.runId,
    taskId: binding.taskId,
    projectId: binding.projectId,
    role: binding.role,
    state: config.checkpointState,
    poster,
  });
  state.tools = [
    ...state.tools.filter((candidate) => candidate.name !== "request_checkpoint"),
    tool,
  ];
}
