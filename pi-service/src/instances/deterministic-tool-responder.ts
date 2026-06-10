/**
 * Deterministic tool-backed responder for narrow runtime smoke tests.
 *
 * This is deliberately not a general LLM/provider integration. It recognizes
 * the controlled #2020 arithmetic scenario and delegates calculation to a
 * typed static tool, then falls back to the echo responder for all other input.
 *
 * @module pi-service/instances/deterministic-tool-responder
 */

import type { ChannelContent, EventBus } from "@pi-crew/core";
import { ConfigurationError } from "@pi-crew/core";
import type {
  AgentResponseRequest,
  AgentResponder,
  AgentResponderFactory,
  AgentResponderFactoryContext,
} from "./agent-responder.js";
import { EchoAgentResponder } from "./agent-responder.js";

const DETERMINISTIC_ARITHMETIC_TOOL_NAME = "deterministic_arithmetic_sum";

/** Parsed arithmetic request supported by the deterministic smoke tool. */
export interface DeterministicArithmeticRequest {
  readonly left: number;
  readonly right: number;
}

/** Successful deterministic arithmetic tool output. */
export interface DeterministicArithmeticResult {
  readonly sum: number;
  readonly responseText: string;
}

/** Small static runtime tool contract for deterministic responder paths. */
export interface DeterministicRuntimeTool {
  readonly name: string;
  execute(
    request: DeterministicArithmeticRequest,
  ): Promise<DeterministicArithmeticResult>;
}

/** Options for the deterministic responder. */
export interface DeterministicToolAgentResponderOptions {
  readonly tool: DeterministicRuntimeTool;
  readonly fallback?: AgentResponder;
  readonly eventBus?: EventBus;
}

/** Options for selecting deterministic runtime responder mode. */
export interface DeterministicToolAgentResponderFactoryOptions {
  readonly tool?: DeterministicRuntimeTool;
  readonly fallback?: AgentResponder;
  readonly eventBus?: EventBus;
}

/** Static arithmetic tool used for the controlled #2020 non-echo scenario. */
export class DeterministicArithmeticTool implements DeterministicRuntimeTool {
  public readonly name = DETERMINISTIC_ARITHMETIC_TOOL_NAME;

  execute(
    request: DeterministicArithmeticRequest,
  ): Promise<DeterministicArithmeticResult> {
    const sum = request.left + request.right;
    return Promise.resolve({
      sum,
      responseText: `NON_ECHO_RUNTIME_OK:${String(sum)}`,
    });
  }
}

/**
 * Parse unknown inbound text into the one deterministic arithmetic domain type.
 */
export function parseDeterministicArithmeticRequest(
  input: unknown,
): DeterministicArithmeticRequest | null {
  if (typeof input !== "string") {
    return null;
  }

  if (!input.includes("NON_ECHO_RUNTIME_OK")) {
    return null;
  }

  const match = /(?<!\d)(\d+)\s*\+\s*(\d+)(?!\d)/u.exec(input);
  if (match === null) {
    return null;
  }

  const left = Number.parseInt(match[1] ?? "", 10);
  const right = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    return null;
  }

  return { left, right };
}

/** AgentResponder that delegates controlled arithmetic requests to a tool. */
export class DeterministicToolAgentResponder implements AgentResponder {
  private readonly fallback: AgentResponder;

  constructor(private readonly options: DeterministicToolAgentResponderOptions) {
    this.fallback = options.fallback ?? new EchoAgentResponder();
  }

  async respond(request: AgentResponseRequest): Promise<ChannelContent> {
    const text =
      request.message.content.kind === "text"
        ? request.message.content.text
        : null;
    const parsed = parseDeterministicArithmeticRequest(text);
    if (parsed === null) {
      return this.fallback.respond(request);
    }

    this.options.eventBus?.emit({
      event: "tool.called",
      payload: {
        toolName: this.options.tool.name,
        sessionId: request.sessionId,
        params: parsed,
      },
    });

    const startedAt = Date.now();
    const result = await this.options.tool.execute(parsed);
    this.options.eventBus?.emit({
      event: "tool.completed",
      payload: {
        toolName: this.options.tool.name,
        sessionId: request.sessionId,
        success: true,
        durationMs: Date.now() - startedAt,
        result,
      },
    });

    return { kind: "text", text: result.responseText };
  }
}

/** Factory for deterministic runtime mode; fails closed without its tool. */
export class DeterministicToolAgentResponderFactory
  implements AgentResponderFactory
{
  constructor(
    private readonly options: DeterministicToolAgentResponderFactoryOptions,
  ) {}

  createResponder(context: AgentResponderFactoryContext): AgentResponder {
    void context;
    if (this.options.tool === undefined) {
      throw new ConfigurationError(
        "Deterministic runtime mode requires a deterministic arithmetic tool",
      );
    }

    return new DeterministicToolAgentResponder({
      tool: this.options.tool,
      fallback: this.options.fallback,
      eventBus: this.options.eventBus,
    });
  }
}
