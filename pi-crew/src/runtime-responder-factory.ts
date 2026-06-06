/**
 * Runtime responder factory selection for the pi-crew composition root.
 *
 * @module pi-crew/runtime-responder-factory
 */

import type { EventBus } from "@pi-crew/core";
import { ConfigurationError } from "@pi-crew/core";
import {
  DeterministicArithmeticTool,
  DeterministicToolAgentResponderFactory,
  EchoAgentResponderFactory,
  type AgentResponderFactory,
  type RuntimeConfig,
} from "@pi-crew/service";

/**
 * Build the AgentResponderFactory selected by validated runtime config.
 */
export function buildRuntimeResponderFactory(
  runtime: RuntimeConfig,
  eventBus: EventBus,
): AgentResponderFactory {
  switch (runtime.responseMode) {
    case "echo":
      return new EchoAgentResponderFactory();
    case "deterministicTool":
      if (!runtime.deterministicTool.arithmeticToolEnabled) {
        throw new ConfigurationError(
          "Deterministic runtime mode requires runtime.deterministicTool.arithmeticToolEnabled=true",
        );
      }
      return new DeterministicToolAgentResponderFactory({
        tool: new DeterministicArithmeticTool(),
        eventBus,
      });
  }

  const exhaustive: never = runtime.responseMode;
  throw new ConfigurationError(
    `Unsupported runtime response mode: ${String(exhaustive)}`,
  );
}
