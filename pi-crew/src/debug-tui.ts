#!/usr/bin/env -S tsx
/** Human-navigable direct-debug terminal client for service-backed pi-crew sessions. */
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import {
  DebugApiClient,
  DebugApiClientError,
  type DebugApiClientConfig,
  type DebugEventRecord,
  type DebugMessageRecord,
  type DebugSessionSummary,
} from "./debug-api-client.js";
import { renderDebugTui } from "./debug-tui-render.js";
import {
  actionFromKey,
  createDebugTuiModel,
  reduceDebugTuiModel,
  type DebugTranscriptLine,
  type DebugTuiModel,
} from "./debug-tui-state.js";

export interface DebugTuiOptions extends DebugApiClientConfig {
  readonly initialSessionId?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly clearScreen?: boolean;
}

export type DebugTuiState = LegacyDebugTuiState;
export interface LegacyDebugTuiState {
  selectedSessionId: string | null;
  sessions: readonly DebugSessionSummary[];
  transcript: readonly DebugTranscriptLine[];
  events: readonly DebugEventRecord[];
  status: string;
}

const CONTEXT_LIMIT = 60;
const EVENTS_LIMIT = 80;

interface RawInputStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): this;
  resume(): this;
  pause(): this;
}

interface RenderOutputStream extends NodeJS.WritableStream {
  readonly columns?: number;
  readonly rows?: number;
}

export async function runPiCrewDebugTui(options: DebugTuiOptions): Promise<number> {
  const client = new DebugApiClient(options);
  const input = (options.input ?? defaultInput) as RawInputStream;
  const output = (options.output ?? defaultOutput) as RenderOutputStream;
  let model = createDebugTuiModel(options.initialSessionId);
  const controller = new TerminalController(input, output, options.clearScreen ?? true);
  try {
    controller.enter();
    model = await refreshModel(client, model, options.initialSessionId);
    controller.render(model);
    for (;;) {
      const key = await controller.nextKey();
      const action = actionFromKey(key, model);
      if (action === null) continue;
      model = reduceDebugTuiModel(model, action);
      model = await runEffects(client, model);
      controller.render(model);
      if (model.shouldQuit) return 0;
    }
  } catch (error: unknown) {
    if (isInputClosed(error)) return 0;
    output.write(`\n${formatError(error)}\n`);
    return 1;
  } finally {
    controller.exit();
  }
}

export async function handleLine(
  client: DebugApiClient,
  state: LegacyDebugTuiState,
  line: string,
): Promise<void> {
  if (line === "/sessions") {
    state.sessions = await client.listSessions();
    state.status = `loaded ${String(state.sessions.length)} session(s)`;
    return;
  }
  if (line.startsWith("/select ")) {
    state.selectedSessionId = line.slice("/select ".length).trim();
    state.status = `selected ${state.selectedSessionId}`;
    state.events = await client.listEvents(requireLegacySession(state), EVENTS_LIMIT);
    return;
  }
  if (line === "/context") {
    const context = await client.getContext(requireLegacySession(state), 30);
    state.transcript = context.messages.map(messageToTranscriptLine);
    state.status = `loaded ${String(context.messages.length)} context message(s)`;
    return;
  }
  if (line === "/events") {
    state.events = await client.listEvents(requireLegacySession(state), EVENTS_LIMIT);
    state.status = `loaded ${String(state.events.length)} event(s)`;
    return;
  }
  if (line === "/tools") {
    const inventory = await client.listTools(requireLegacySession(state));
    state.transcript = [...state.transcript, { role: "system", text: JSON.stringify(inventory, null, 2) }];
    state.status = "loaded tool inventory";
    return;
  }
  if (line === "/help") {
    state.status = "TUI-local: keyboard navigation, session list, context/events/tools views. Service slash commands are sent as turns.";
    return;
  }
  state.transcript = [...state.transcript, { role: "operator", text: line }];
  const response = await client.postTurn(requireLegacySession(state), line, "direct-debug-tui");
  state.transcript = [...state.transcript, { role: "assistant", text: response.message }];
  state.events = response.events.map((payload) => ({ payload }));
  state.status = `turn ${response.turnId} completed`;
}

async function refreshModel(
  client: DebugApiClient,
  model: DebugTuiModel,
  preferredSessionId?: string,
): Promise<DebugTuiModel> {
  try {
    let next = reduceDebugTuiModel(model, {
      type: "sessionsLoaded",
      sessions: await client.listSessions(),
      preferredSessionId,
    });
    next = await refreshSelectedDetails(client, next);
    return next;
  } catch (error: unknown) {
    return reduceDebugTuiModel(model, { type: "error", message: formatError(error) });
  }
}

async function refreshSelectedDetails(client: DebugApiClient, model: DebugTuiModel): Promise<DebugTuiModel> {
  if (model.selectedSessionId === null) return model;
  let next = reduceDebugTuiModel(model, {
    type: "contextLoaded",
    ...(await contextAction(client, model.selectedSessionId)),
  });
  next = reduceDebugTuiModel(next, {
    type: "eventsLoaded",
    events: await client.listEvents(model.selectedSessionId, EVENTS_LIMIT),
  });
  if (next.view === "tools") {
    next = reduceDebugTuiModel(next, { type: "toolsLoaded", tools: await client.listTools(model.selectedSessionId) });
  }
  return next;
}

async function runEffects(client: DebugApiClient, model: DebugTuiModel): Promise<DebugTuiModel> {
  let next = model;
  if (next.refreshRequested) {
    next = reduceDebugTuiModel(next, { type: "clearTransient" });
    next = await refreshModel(client, next, next.selectedSessionId ?? undefined);
  }
  if (next.submitRequested !== null) {
    const message = next.submitRequested;
    next = reduceDebugTuiModel(next, { type: "turnStarted", message });
    try {
      const response = await client.postTurn(requireSelectedSession(next), message, "direct-debug-tui");
      next = reduceDebugTuiModel(next, {
        type: "turnCompleted",
        message: response.message,
        turnId: response.turnId,
        events: response.events,
      });
    } catch (error: unknown) {
      next = reduceDebugTuiModel(next, { type: "error", message: formatError(error) });
    }
  }
  if (next.view === "tools" && next.toolsText.length === 0 && next.selectedSessionId !== null) {
    try {
      next = reduceDebugTuiModel(next, { type: "toolsLoaded", tools: await client.listTools(next.selectedSessionId) });
    } catch (error: unknown) {
      next = reduceDebugTuiModel(next, { type: "error", message: formatError(error) });
    }
  }
  return next;
}

async function contextAction(
  client: DebugApiClient,
  sessionId: string,
): Promise<{ messages: readonly DebugMessageRecord[]; messageCount: number }> {
  const context = await client.getContext(sessionId, CONTEXT_LIMIT);
  return { messages: context.messages, messageCount: context.messageCount };
}

class TerminalController {
  readonly #input: RawInputStream;
  readonly #output: RenderOutputStream;
  readonly #clearScreen: boolean;
  readonly #queue: string[] = [];
  readonly #waiting: Array<(value: string) => void> = [];
  readonly #onData = (chunk: Buffer | string): void => {
    for (const key of splitKeyData(chunk.toString("utf8"))) this.#pushKey(key);
  };

  constructor(input: RawInputStream, output: RenderOutputStream, clearScreen: boolean) {
    this.#input = input;
    this.#output = output;
    this.#clearScreen = clearScreen;
  }

  enter(): void {
    this.#input.setRawMode?.(true);
    this.#input.resume();
    this.#input.on("data", this.#onData);
    if (this.#clearScreen) this.#output.write("\x1b[?1049h\x1b[?25l");
  }

  exit(): void {
    this.#input.off("data", this.#onData);
    this.#input.setRawMode?.(false);
    if (this.#clearScreen) this.#output.write("\x1b[?25h\x1b[?1049l");
  }

  render(model: DebugTuiModel): void {
    const width = this.#output.columns ?? 100;
    const height = this.#output.rows ?? 32;
    if (this.#clearScreen) this.#output.write("\x1b[H\x1b[2J");
    this.#output.write(renderDebugTui(model, { width, height }));
  }

  nextKey(): Promise<string> {
    const next = this.#queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #pushKey(key: string): void {
    const waiter = this.#waiting.shift();
    if (waiter === undefined) this.#queue.push(key);
    else waiter(key);
  }
}

function splitKeyData(data: string): readonly string[] {
  const keys: string[] = [];
  for (let index = 0; index < data.length;) {
    if (data.startsWith("\x1b[5~", index) || data.startsWith("\x1b[6~", index)) {
      keys.push(data.slice(index, index + 4));
      index += 4;
    } else if (data.startsWith("\x1b[Z", index) || data.startsWith("\x1b[A", index) || data.startsWith("\x1b[B", index)) {
      keys.push(data.slice(index, index + 3));
      index += 3;
    } else if (data[index] === "\x1b") {
      keys.push("\x1b");
      index += 1;
    } else {
      keys.push(data[index] ?? "");
      index += 1;
    }
  }
  return keys.filter((key) => key.length > 0);
}

function messageToTranscriptLine(message: DebugMessageRecord): DebugTranscriptLine {
  if (message.role === "assistant") return { role: "assistant", text: message.content };
  if (message.role === "user") return { role: "operator", text: message.content };
  const label = message.toolName === null ? message.role : `${message.role}:${message.toolName}`;
  return { role: "system", text: `[${label} #${String(message.id)}] ${message.content}` };
}

function requireSelectedSession(model: DebugTuiModel): string {
  if (model.selectedSessionId !== null && model.selectedSessionId.trim().length > 0) return model.selectedSessionId;
  throw new DebugApiClientError("No session selected");
}

function requireLegacySession(state: LegacyDebugTuiState): string {
  if (state.selectedSessionId !== null && state.selectedSessionId.trim().length > 0) return state.selectedSessionId;
  throw new DebugApiClientError("No session selected");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isInputClosed(error: unknown): boolean {
  return error instanceof Error && (error.message === "readline was closed" || error.name === "AbortError");
}
