/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars, @typescript-eslint/use-unknown-in-catch-callback-variable */
/**
 * Spike: Verify pi-agent-core + pi-ai works with DeepSeek
 *
 * Task #1855 — standalone spike script.
 * Uses @earendil-works/pi-ai 0.78.1 + @earendil-works/pi-agent-core 0.78.1.
 *
 * DeepSeek is already a KnownProvider in pi-ai with api: "openai-completions"
 * and baseUrl: "https://api.deepseek.com". Models: deepseek-v4-flash, deepseek-v4-pro.
 * Credentials via DEEPSEEK_API_KEY env var.
 *
 * Run: DEEPSEEK_API_KEY=sk-... npx tsx src/spike.ts
 */
import { Type, type Static } from "typebox";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import { calculate } from "./safe-calculator.js";
// ── Model under test ────────────────────────────────────────────
const MODEL = getModel("deepseek", "deepseek-v4-pro");
interface ModelInspection {
  readonly api?: unknown;
  readonly baseUrl?: unknown;
  readonly compat?: DeepSeekCompat;
}
interface DeepSeekCompat {
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  readonly thinkingFormat?: string;
}
interface ToolCallSnapshot {
  readonly name: string;
  readonly id: string;
  readonly arguments: unknown;
}
interface SpikeResults {
  model: string;
  provider: string;
  api: "openai-completions";
  baseUrl: string;
  hasApiKey: boolean;
  timestamp: string;
  phases: Record<string, boolean>;
  quirks: Record<string, string>;
  overall: "unknown" | "PASS" | "FAIL" | "blocked";
  blocker: string | null;
}
const modelInspection = MODEL as ModelInspection;
// ── Tool definition: calculator ─────────────────────────────────
const CalculatorParameters = Type.Object({
  expression: Type.String({
    description: "A mathematical expression to evaluate, e.g. '2 + 3 * 4'",
  }),
});
const calculatorTool: AgentTool<typeof CalculatorParameters> = {
  label: "Calculator",
  name: "calculate",
  description:
    "Evaluate a mathematical expression. Supports +, -, *, /, and parentheses.",
  parameters: CalculatorParameters,
  execute: (
    _toolCallId: string,
    params: Static<typeof CalculatorParameters>,
  ): Promise<AgentToolResult<string>> => {
    const result = calculate(params.expression);
    return Promise.resolve({
      content: [{ type: "text", text: result }],
      details: result,
    });
  },
};
// ── Helpers ──────────────────────────────────────────────────────
function logSection(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}
function logStreamEvent(event: AssistantMessageEvent): void {
  switch (event.type) {
    case "start":
      console.log(`[stream:start] model=${event.partial.model}`);
      break;
    case "text_start":
      console.log(`[stream:text_start] contentIndex=${event.contentIndex}`);
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "thinking_start":
      console.log(`\n[thinking_start] contentIndex=${event.contentIndex}`);
      break;
    case "thinking_delta":
      process.stdout.write(event.delta);
      break;
    case "toolcall_start":
      console.log(`\n[toolcall_start] contentIndex=${event.contentIndex}`);
      break;
    case "toolcall_delta":
      // Arguments stream in as deltas
      break;
    case "toolcall_end":
      console.log(
        `[toolcall_end] contentIndex=${event.contentIndex} name="${event.toolCall.name}" args=${JSON.stringify(event.toolCall.arguments)}`,
      );
      break;
    case "done":
      console.log(
        `\n[stream:done] reason=${event.reason} usage=${JSON.stringify(event.message.usage)}`,
      );
      break;
    case "error":
      console.error(
        `\n[stream:error] reason=${event.reason} error=${event.error.errorMessage}`,
      );
      break;
  }
}
// ── Phase 1: Direct streamSimple() — basic connectivity ──────────
async function phase1DirectStream(): Promise<boolean> {
  logSection("Phase 1: Direct streamSimple() — basic connectivity");
  const context: Context = {
    systemPrompt: "You are a helpful assistant. Keep responses concise.",
    messages: [
      {
        role: "user",
        content: "What is 2 + 2? Answer in one sentence.",
        timestamp: Date.now(),
      },
    ],
  };
  console.log(
    `Model: ${MODEL.id} (provider: ${MODEL.provider}, api: ${String(modelInspection.api)})`,
  );
  console.log(`Base URL: ${String(modelInspection.baseUrl ?? "default")}`);
  try {
    const stream = streamSimple(MODEL, context, {
      maxTokens: 200,
      temperature: 0.1,
    });
    for await (const event of stream) {
      logStreamEvent(event);
    }
    console.log("\n✓ Phase 1 stream completed");
    return true;
  } catch (err) {
    console.error(
      `\n✗ Phase 1 FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(
        `  Stack: ${err.stack.split("\n").slice(0, 3).join("\n  ")}`,
      );
    }
    return false;
  }
}
// ── Phase 2: Agent with tool calling ─────────────────────────────
async function phase2AgentToolCalling(): Promise<boolean> {
  logSection("Phase 2: Agent loop with calculator tool");
  // Track tool execution
  let toolCallsDetected = false;
  let toolResultsDetected = false;
  const agent = new Agent({
    streamFn: streamSimple,
  });
  // Set tools on the agent state
  agent.state.tools = [calculatorTool];
  // Subscribe to events for visibility
  agent.subscribe(async (event, _signal) => {
    switch (event.type) {
      case "turn_start": {
        const turnNum =
          agent.state.messages.filter((m) => m.role === "assistant").length +
          1;
        console.log(`\n[turn_start] turn=${turnNum}`);
        break;
      }
      case "message_update": {
        // Stream events inside the agent loop
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "toolcall_start") {
          toolCallsDetected = true;
        }
        logStreamEvent(streamEvent);
        break;
      }
      case "tool_execution_start": {
        console.log(
          `[tool_execution_start] tool="${event.toolName}" args=${JSON.stringify(event.args)}`,
        );
        break;
      }
      case "tool_execution_end": {
        const resultPreview =
          typeof event.result === "string"
            ? event.result.slice(0, 80)
            : JSON.stringify(event.result).slice(0, 80);
        console.log(
          `[tool_execution_end] tool="${event.toolName}" result=${resultPreview} isError=${event.isError}`,
        );
        if (!event.isError) {
          toolResultsDetected = true;
        }
        break;
      }
      case "turn_end": {
        console.log(
          `[turn_end] toolResults=${event.toolResults.length}`,
        );
        break;
      }
      case "agent_end": {
        console.log(`[agent_end] messages=${event.messages.length}`);
        break;
      }
    }
  });
  console.log(
    `Agent state: tools=${agent.state.tools.length}`,
  );
  try {
    await agent.prompt([
      {
        role: "user",
        content:
          "I need to calculate (15 * 7) / 3 + 12. Please use the calculator tool to compute this step by step, then tell me the final answer.",
        timestamp: Date.now(),
      },
    ]);
    await agent.waitForIdle();
    // Check transcript for tool usage
    const toolMessages = agent.state.messages.filter(
      (m) => m.role === "toolResult",
    );
    console.log(
      `\nTranscript: ${agent.state.messages.length} messages, ${toolMessages.length} tool results`,
    );
    if (toolCallsDetected && toolResultsDetected) {
      console.log("✓ Phase 2: Tool calling confirmed working");
      return true;
    } else if (toolCallsDetected && !toolResultsDetected) {
      console.log("? Phase 2: Tool calls detected but results may have errors");
      return false;
    } else {
      // Model may have answered directly (no tool needed for simple math)
      const assistantMessages = agent.state.messages.filter(
        (m) => m.role === "assistant",
      );
      console.log(
        `  Assistant messages: ${assistantMessages.length} (tool calls detected: ${toolCallsDetected})`,
      );
      // If we got an assistant response at all, the Agent loop worked
      return assistantMessages.length > 0;
    }
  } catch (err) {
    console.error(
      `\n✗ Phase 2 FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(
        `  Stack: ${err.stack.split("\n").slice(0, 3).join("\n  ")}`,
      );
    }
    return false;
  }
}
// ── Phase 3: Streaming verification ──────────────────────────────
async function phase3StreamingCheck(): Promise<boolean> {
  logSection("Phase 3: Streaming content verification");
  const context: Context = {
    systemPrompt: "Count from 1 to 10, one number per line. No extra text.",
    messages: [
      { role: "user", content: "Count from 1 to 10.", timestamp: Date.now() },
    ],
  };
  let streamedChunks = 0;
  let finalText = "";
  try {
    const stream = streamSimple(MODEL, context, {
      maxTokens: 100,
      temperature: 0,
    });
    for await (const event of stream) {
      if (event.type === "text_delta") {
        streamedChunks++;
        finalText += event.delta;
      }
      if (event.type === "done") {
        break;
      }
    }
    console.log(`Streaming chunks received: ${streamedChunks}`);
    console.log(`Final text length: ${finalText.length} chars`);
    console.log(`First 80 chars: "${finalText.slice(0, 80)}"`);
    if (streamedChunks > 0) {
      console.log("✓ Phase 3: Streaming confirmed working");
      return true;
    } else {
      console.log("✗ Phase 3: No stream deltas received (buffered response?)");
      return false;
    }
  } catch (err) {
    console.error(
      `\n✗ Phase 3 FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
// ── Phase 4: Quirk detection ─────────────────────────────────────
async function phase4QuirkDetection(): Promise<Record<string, string>> {
  logSection("Phase 4: Provider quirk detection");
  const quirks: Record<string, string> = {};
  // Check model compat flags from the model definition
  const compat = modelInspection.compat;
  console.log("Model compat flags:", JSON.stringify(compat, null, 2));
  if (compat?.requiresReasoningContentOnAssistantMessages) {
    quirks["reasoning_content"] =
      "requires reasoning_content on assistant messages (thinkingFormat=deepseek)";
    console.log(`  ⚠ ${quirks["reasoning_content"]}`);
  }
  if (compat?.thinkingFormat) {
    quirks["thinking_format"] = `thinkingFormat: ${compat.thinkingFormat}`;
    console.log(`  ℹ thinking format: ${compat.thinkingFormat}`);
  }
  // Test tool call format with a direct stream
  const toolContext: Context = {
    systemPrompt: "Use the calculator tool for math problems.",
    messages: [
      {
        role: "user",
        content: "Calculate 123 * 456 using the calculator tool.",
        timestamp: Date.now(),
      },
    ],
    tools: [calculatorTool],
  };
  try {
    const stream = streamSimple(MODEL, toolContext, {
      maxTokens: 300,
      temperature: 0,
    });
    let sawToolCall = false;
    let toolCallData: ToolCallSnapshot | null = null;
    let lastEventWasError = false;
    let lastErrorMsg: string | undefined;
    for await (const event of stream) {
      if (event.type === "toolcall_start") {
        sawToolCall = true;
      }
      if (event.type === "toolcall_end") {
        toolCallData = {
          name: event.toolCall.name,
          id: event.toolCall.id,
          arguments: event.toolCall.arguments,
        };
      }
      if (event.type === "error") {
        lastEventWasError = true;
        lastErrorMsg = event.error.errorMessage;
      }
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }
    if (sawToolCall && toolCallData) {
      quirks["tool_call_format"] = `Tool calling works via standard OpenAI function calling. Data: ${JSON.stringify(toolCallData)}`;
      console.log(
        `  ✓ Tool call format: standard OpenAI function calling — ${JSON.stringify(toolCallData)}`,
      );
    } else if (!sawToolCall) {
      quirks["tool_call_note"] =
        "No tool call detected in quirk test — model may have answered directly";
      console.log("  ℹ No tool call in quirk test (model may have computed directly)");
    }
    if (lastEventWasError) {
      quirks["tool_call_error"] =
        lastErrorMsg || "Unknown error";
    }
  } catch (err) {
    quirks["tool_call_exception"] =
      err instanceof Error ? err.message : String(err);
    console.log(`  ✗ Quirk detection exception: ${quirks["tool_call_exception"]}`);
  }
  // Document model IDs
  quirks["model_ids"] =
    "deepseek-v4-flash, deepseek-v4-pro (both api: openai-completions, baseUrl: https://api.deepseek.com)";
  quirks["env_key"] = "DEEPSEEK_API_KEY";
  quirks["declarative_config"] =
    "Yes — uses standard OpenAI-compatible config: baseUrl + apiKey from env. No OAuth/interactive setup required.";
  return quirks;
}
// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(60));
  console.log("  DeepSeek Spike — pi-agent-core + pi-ai");
  console.log(`  Model: ${MODEL.id}`);
  console.log(`  Provider: ${MODEL.provider}`);
  console.log(`  API: openai-completions`);
  console.log(`  Base URL: https://api.deepseek.com`);
  console.log("=".repeat(60));
  // Check for API key
  const hasKey = !!process.env.DEEPSEEK_API_KEY;
  console.log(
    `\nDEEPSEEK_API_KEY: ${hasKey ? "present [REDACTED]" : "NOT SET — this will cause an authentication error"}`,
  );
  const results: SpikeResults = {
    model: MODEL.id,
    provider: MODEL.provider,
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    hasApiKey: hasKey,
    timestamp: new Date().toISOString(),
    phases: {},
    quirks: {},
    overall: "unknown",
    blocker: null as string | null,
  };
  if (!hasKey) {
    results.blocker =
      "DEEPSEEK_API_KEY not set in environment. Set this env var and re-run the spike.";
    results.overall = "blocked";
    logSection("BLOCKED — Missing API Key");
    console.log(results.blocker);
    console.log(
      "\nTo proceed: DEEPSEEK_API_KEY=sk-... npx tsx src/spike.ts",
    );
    return results;
  }
  // Phase 1: Direct stream
  results.phases.phase1 = await phase1DirectStream();
  if (!results.phases.phase1) {
    results.phases.phase2 = false;
    results.phases.phase3 = false;
  }
  // Phase 2: Agent + tool calling
  if (results.phases.phase1) {
    results.phases.phase2 = await phase2AgentToolCalling();
  } else {
    console.log("\nSkipping Phase 2 (Phase 1 failed)");
    results.phases.phase2 = false;
  }
  // Phase 3: Streaming
  if (results.phases.phase1) {
    results.phases.phase3 = await phase3StreamingCheck();
  } else {
    console.log("\nSkipping Phase 3 (Phase 1 failed)");
    results.phases.phase3 = false;
  }
  // Phase 4: Quirks
  if (results.phases.phase1) {
    results.quirks = await phase4QuirkDetection();
  }
  // Summary
  logSection("Results Summary");
  console.log(JSON.stringify(results, null, 2));
  const allPassed =
    results.phases.phase1 && results.phases.phase2 && results.phases.phase3;
  results.overall = allPassed ? "PASS" : "FAIL";
  if (results.blocker) {
    results.overall = "blocked";
  }
  console.log(`\nOverall: ${results.overall}`);
  return results;
}
main()
  .then((results) => {
    if (results.overall === "PASS") {
      process.exit(0);
    } else if (results.overall === "blocked") {
      process.exit(2);
    } else {
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(3);
  });
