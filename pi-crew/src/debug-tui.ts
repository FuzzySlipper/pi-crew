#!/usr/bin/env -S tsx
/** Direct-debug terminal UI for service-backed pi-crew full-agent sessions. */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  DebugApiClient,
  DebugApiClientError,
  type DebugApiClientConfig,
  type DebugEventRecord,
  type DebugMessageRecord,
  type DebugSessionSummary,
} from "./debug-api-client.js";

export interface DebugTuiOptions extends DebugApiClientConfig {
  readonly initialSessionId?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly clearScreen?: boolean;
}

export interface DebugTuiState {
  selectedSessionId: string | null;
  sessions: readonly DebugSessionSummary[];
  transcript: readonly TranscriptLine[];
  events: readonly DebugEventRecord[];
  status: string;
}

export interface TranscriptLine {
  readonly role: "operator" | "assistant" | "system";
  readonly text: string;
}

const CONTEXT_LIMIT = 30;
const EVENTS_LIMIT = 30;
const MAX_PANEL_LINES = 12;

export async function runPiCrewDebugTui(options: DebugTuiOptions): Promise<number> {
  const client = new DebugApiClient(options);
  const screen = new TuiScreen(options.output ?? output, options.clearScreen ?? true);
  const rl = createInterface({ input: options.input ?? input, output: options.output ?? output });
  const state: DebugTuiState = {
    selectedSessionId: options.initialSessionId ?? null,
    sessions: [],
    transcript: [],
    events: [],
    status: "connecting to direct-debug API",
  };
  try {
    await refreshSessions(client, state);
    if (state.selectedSessionId === null) {
      state.selectedSessionId = state.sessions[0]?.sessionId ?? null;
    }
    await refreshEvents(client, state);
    screen.render(state);
    for (;;) {
      const line = await rl.question(promptFor(state));
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed === "/quit" || trimmed === "/exit") return 0;
      await handleLine(client, state, trimmed);
      screen.render(state);
    }
  } catch (error: unknown) {
    if (isReadlineClosed(error)) return 0;
    screen.writeLine(formatError(error));
    return 1;
  } finally {
    rl.close();
  }
}

export async function handleLine(
  client: DebugApiClient,
  state: DebugTuiState,
  line: string,
): Promise<void> {
  if (line === "/sessions") {
    await refreshSessions(client, state);
    return;
  }
  if (line.startsWith("/select ")) {
    const sessionId = line.slice("/select ".length).trim();
    state.selectedSessionId = sessionId;
    state.status = `selected ${sessionId}`;
    await refreshEvents(client, state);
    return;
  }
  if (line === "/context") {
    await loadContext(client, state);
    return;
  }
  if (line === "/events") {
    await refreshEvents(client, state);
    return;
  }
  if (line === "/tools") {
    await loadTools(client, state);
    return;
  }
  if (line === "/help") {
    state.status = "local TUI commands: /sessions, /select <id>, /context, /events, /tools, /quit. Other slash commands are sent to the service router.";
    return;
  }
  await sendTurn(client, state, line);
}

async function refreshSessions(client: DebugApiClient, state: DebugTuiState): Promise<void> {
  state.sessions = await client.listSessions();
  state.status = `loaded ${String(state.sessions.length)} session(s)`;
}

async function refreshEvents(client: DebugApiClient, state: DebugTuiState): Promise<void> {
  const sessionId = requireSelectedSession(state);
  state.events = await client.listEvents(sessionId, EVENTS_LIMIT);
  state.status = `loaded ${String(state.events.length)} recent event(s) for ${sessionId}`;
}

async function loadContext(client: DebugApiClient, state: DebugTuiState): Promise<void> {
  const sessionId = requireSelectedSession(state);
  const context = await client.getContext(sessionId, CONTEXT_LIMIT);
  state.transcript = context.messages.map(messageToTranscriptLine);
  state.status = `loaded ${String(context.messages.length)} of ${String(context.messageCount)} message(s) for ${sessionId}`;
}

async function loadTools(client: DebugApiClient, state: DebugTuiState): Promise<void> {
  const sessionId = requireSelectedSession(state);
  const inventory = await client.listTools(sessionId);
  state.transcript = [
    ...state.transcript,
    { role: "system", text: `tool inventory for ${sessionId}:\n${JSON.stringify(inventory, null, 2)}` },
  ];
  state.status = `loaded tool inventory for ${sessionId}`;
}

async function sendTurn(client: DebugApiClient, state: DebugTuiState, line: string): Promise<void> {
  const sessionId = requireSelectedSession(state);
  state.transcript = [...state.transcript, { role: "operator", text: line }];
  state.status = `sending turn to ${sessionId}`;
  const response = await client.postTurn(sessionId, line, "direct-debug-tui");
  state.transcript = [...state.transcript, { role: "assistant", text: response.message }];
  state.events = response.events.map((event) => ({ payload: event }));
  state.status = `turn ${response.turnId} completed; toolCalls=${String(response.toolCalls.length)} delegations=${String(response.delegationHandles.length)}`;
}

function messageToTranscriptLine(message: DebugMessageRecord): TranscriptLine {
  if (message.role === "assistant") return { role: "assistant", text: message.content };
  if (message.role === "user") return { role: "operator", text: message.content };
  const label = message.toolName === null ? message.role : `${message.role}:${message.toolName}`;
  return { role: "system", text: `[${label} #${String(message.id)}] ${message.content}` };
}

function requireSelectedSession(state: DebugTuiState): string {
  if (state.selectedSessionId !== null && state.selectedSessionId.trim() !== "") {
    return state.selectedSessionId;
  }
  throw new DebugApiClientError("No session selected; use /sessions then /select <sessionId>");
}

function promptFor(state: DebugTuiState): string {
  return `\n${state.selectedSessionId ?? "no-session"}> `;
}

class TuiScreen {
  readonly #output: NodeJS.WritableStream;
  readonly #clearScreen: boolean;

  constructor(outputStream: NodeJS.WritableStream, clearScreen: boolean) {
    this.#output = outputStream;
    this.#clearScreen = clearScreen;
  }

  render(state: DebugTuiState): void {
    if (this.#clearScreen) this.#output.write("\x1b[2J\x1b[H");
    this.writeLine("pi-crew direct-debug TUI (high-trust diagnostic path; not Den Channels transport)");
    this.writeLine(`status: ${state.status}`);
    this.writeLine("");
    this.writeLine("sessions");
    for (const session of state.sessions.slice(0, MAX_PANEL_LINES)) {
      const marker = session.sessionId === state.selectedSessionId ? "→" : " ";
      this.writeLine(
        `${marker} ${session.sessionId} profile=${session.profileId} instance=${session.instanceId ?? "none"} ` +
          `state=${session.sessionState}/${session.presenceStatus} class=${session.classification} ` +
          `errors=${String(session.recentErrorCount)} messages=${String(session.messageCount)}`,
      );
    }
    this.writeLine("");
    this.writeLine("chat/context");
    for (const line of state.transcript.slice(-MAX_PANEL_LINES)) this.writeLine(formatTranscriptLine(line));
    this.writeLine("");
    this.writeLine("events");
    for (const event of state.events.slice(-MAX_PANEL_LINES)) this.writeLine(formatEvent(event));
    this.writeLine("");
    this.writeLine("local commands: /sessions /select <id> /context /events /tools /help /quit");
    this.writeLine("service slash commands: type /status, /new, /reload-mcp, etc. as normal chat input");
  }

  writeLine(line: string): void {
    this.#output.write(`${line}\n`);
  }
}

function formatTranscriptLine(line: TranscriptLine): string {
  const prefix = line.role === "operator" ? "you" : line.role;
  return `${prefix}: ${firstLines(line.text, 4)}`;
}

function formatEvent(event: DebugEventRecord): string {
  const head = [event.sequence, event.observedAt, event.event].filter((value) => value !== undefined).join(" ");
  const payload = event.payload === undefined ? "" : JSON.stringify(event.payload);
  return firstLines(`${head} ${payload}`.trim(), 3);
}

function firstLines(text: string, limit: number): string {
  return text.split("\n").slice(0, limit).join("\n  ");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isReadlineClosed(error: unknown): boolean {
  return error instanceof Error && error.message === "readline was closed";
}
