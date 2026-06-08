/** request_checkpoint tool for supervised Den worker assignments. */

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface CheckpointPacket {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly role: string;
  readonly reason: string;
  readonly since: string;
  readonly toolCallId: string;
}

export interface PostedCheckpoint {
  readonly packet: CheckpointPacket;
  readonly accepted: boolean;
  readonly checkpointId?: string;
  readonly message?: string;
}

export interface CheckpointRuntimeState {
  readonly isCheckpointRequested: boolean;
  readonly currentRequest: PostedCheckpoint | undefined;
  markRequested(request: PostedCheckpoint): void;
  clear(): void;
}

export type CheckpointPoster = (
  packet: CheckpointPacket,
) => Promise<{ readonly accepted: boolean; readonly checkpointId?: string; readonly message?: string }>;

export interface CheckpointAgentToolResult {
  readonly content: readonly TextContent[];
  readonly details: {
    readonly accepted: boolean;
    readonly checkpointId?: string;
    readonly reason: string;
    readonly since: string;
    readonly message?: string;
  };
}

export interface CheckpointAgentTool {
  readonly label: string;
  readonly name: "request_checkpoint";
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown): Promise<CheckpointAgentToolResult>;
}

export interface RequestCheckpointToolConfig {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly role: string;
  readonly state: CheckpointRuntimeState;
  readonly poster: CheckpointPoster;
}

class InMemoryCheckpointState implements CheckpointRuntimeState {
  #request: PostedCheckpoint | undefined;

  get isCheckpointRequested(): boolean {
    return this.#request !== undefined;
  }

  get currentRequest(): PostedCheckpoint | undefined {
    return this.#request;
  }

  markRequested(request: PostedCheckpoint): void {
    this.#request = request;
  }

  clear(): void {
    this.#request = undefined;
  }
}

export function createCheckpointState(): CheckpointRuntimeState {
  return new InMemoryCheckpointState();
}

export function requestCheckpointTool(config: RequestCheckpointToolConfig): CheckpointAgentTool {
  return {
    label: "Request checkpoint",
    name: "request_checkpoint",
    description:
      "Pause this worker assignment after the current tool batch and request orchestrator guidance.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: {
          type: "string",
          description: "Why the worker needs orchestrator input before continuing.",
        },
      },
      required: ["reason"],
    },
    async execute(toolCallId: string, params: unknown): Promise<CheckpointAgentToolResult> {
      const reason = readReason(params);
      const since = new Date().toISOString();
      const packet: CheckpointPacket = {
        assignmentId: config.assignmentId,
        runId: config.runId,
        taskId: config.taskId,
        projectId: config.projectId,
        role: config.role,
        reason,
        since,
        toolCallId,
      };
      const posted = await config.poster(packet);
      if (posted.accepted) {
        config.state.markRequested({
          packet,
          accepted: true,
          checkpointId: posted.checkpointId,
          message: posted.message,
        });
      }
      return {
        content: [
          {
            type: "text",
            text: posted.accepted
              ? `Checkpoint requested: ${reason}`
              : `Checkpoint request rejected: ${posted.message ?? "no reason provided"}`,
          },
        ],
        details: {
          accepted: posted.accepted,
          checkpointId: posted.checkpointId,
          reason,
          since,
          message: posted.message,
        },
      };
    },
  };
}

function readReason(params: unknown): string {
  if (typeof params !== "object" || params === null || !("reason" in params)) {
    return "checkpoint requested";
  }
  const reason = (params as { readonly reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim().length > 0
    ? reason.trim()
    : "checkpoint requested";
}
