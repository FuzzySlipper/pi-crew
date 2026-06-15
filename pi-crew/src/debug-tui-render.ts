/** Full-screen renderer for pi-crew direct-debug TUI state. */
import type { DebugEventRecord, DebugMessageRecord, DebugSessionSummary } from "./debug-api-client.js";
import { activeSession, type DebugTranscriptLine, type DebugTuiModel } from "./debug-tui-state.js";

export interface DebugTuiDimensions {
  readonly width: number;
  readonly height: number;
}

const MIN_WIDTH = 80;
const MIN_HEIGHT = 24;

export function renderDebugTui(model: DebugTuiModel, dimensions: DebugTuiDimensions): string {
  const width = Math.max(MIN_WIDTH, dimensions.width);
  const height = Math.max(MIN_HEIGHT, dimensions.height);
  const bodyHeight = height - 4;
  const leftWidth = Math.max(28, Math.min(42, Math.floor(width * 0.34)));
  const rightWidth = width - leftWidth - 1;
  const left = renderSessions(model, leftWidth, bodyHeight);
  const right = renderBody(model, rightWidth, bodyHeight);
  const lines = [
    banner(width),
    statusLine(model, width),
    ...zipPanels(left, right, leftWidth, rightWidth, bodyHeight),
    footer(model, width),
  ];
  return lines.slice(0, height).map((line) => pad(line, width)).join("\n");
}

function renderSessions(model: DebugTuiModel, width: number, height: number): readonly string[] {
  const lines = [panelTitle(model.focus === "sessions" ? "▶ sessions" : "sessions", width)];
  const bodyHeight = height - 2;
  const start = visibleStart(model.selectedSessionIndex, model.sessions.length, bodyHeight);
  for (const [index, session] of model.sessions.slice(start, start + bodyHeight).entries()) {
    lines.push(renderSession(session, start + index, model, width));
  }
  while (lines.length < height) lines.push("");
  lines.push(scrollHint(start, bodyHeight, model.sessions.length, width));
  return lines.slice(0, height);
}

function renderBody(model: DebugTuiModel, width: number, height: number): readonly string[] {
  const summaryHeight = 4;
  const inputHeight = 4;
  const contentHeight = Math.max(4, height - summaryHeight - inputHeight);
  return [
    ...renderSummary(model, width, summaryHeight),
    ...renderView(model, width, contentHeight),
    ...renderInput(model, width, inputHeight),
  ].slice(0, height);
}

function renderSummary(model: DebugTuiModel, width: number, height: number): readonly string[] {
  const session = activeSession(model);
  const lines = [panelTitle("selected session", width)];
  if (session === null) {
    lines.push("No session selected. Use ↑/↓ then Enter.");
  } else {
    lines.push(truncate(`${session.sessionId} profile=${session.profileId} kind=${session.kind}`, width));
    lines.push(truncate(`state=${session.sessionState}/${session.presenceStatus} class=${session.classification} errors=${String(session.recentErrorCount)} messages=${String(session.messageCount)}`, width));
    lines.push(truncate(`instance=${session.instanceId ?? "none"} last=${session.lastActivityAt}`, width));
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

function renderView(model: DebugTuiModel, width: number, height: number): readonly string[] {
  const lines = [panelTitle(`${model.focus === "body" ? "▶ " : ""}${model.view}`, width)];
  const contentHeight = height - 1;
  const content = viewLines(model, width - 2);
  const offset = currentScroll(model);
  const start = Math.max(0, Math.min(offset, Math.max(0, content.length - contentHeight)));
  for (const line of content.slice(start, start + contentHeight)) lines.push(` ${truncate(line, width - 2)}`);
  while (lines.length < height) lines.push("");
  const hint = scrollHint(start, contentHeight, content.length, width);
  lines[height - 1] = hint;
  return lines;
}

function renderInput(model: DebugTuiModel, width: number, height: number): readonly string[] {
  const label = model.focus === "input" ? "▶ input" : "input";
  const lines = [panelTitle(`${label}${model.busy ? " (busy)" : ""}`, width)];
  const prompt = model.busy ? "waiting for service..." : model.input.length === 0 ? "type a turn; slash commands go to service" : model.input;
  const wrapped = wrapText(prompt, width - 2).slice(0, height - 2);
  for (const line of wrapped) lines.push(` ${line}`);
  while (lines.length < height - 1) lines.push("");
  lines.push(truncate(" Enter=send  Tab=focus  ↑↓/j/k=select/scroll  r=refresh  c/e/t/?=views  q=quit", width));
  return lines;
}

function viewLines(model: DebugTuiModel, width: number): readonly string[] {
  if (model.view === "context") return model.contextMessages.flatMap((message) => messageLines(message, width));
  if (model.view === "events") return eventLines(model, width);
  if (model.view === "tools") return model.toolsText.length === 0 ? ["Press t/r to load tool diagnostics."] : wrapText(model.toolsText, width);
  if (model.view === "help") return helpLines();
  return model.transcript.length === 0 ? ["No chat transcript yet. Focus input, type /status, press Enter."] : model.transcript.flatMap((line) => transcriptLines(line, width));
}

function transcriptLines(line: DebugTranscriptLine, width: number): readonly string[] {
  const prefix = line.role === "operator" ? "you" : line.role;
  return [`${prefix}:`, ...wrapText(line.text, width).map((text) => `  ${text}`), ""];
}

function messageLines(message: DebugMessageRecord, width: number): readonly string[] {
  const label = message.toolName === null ? message.role : `${message.role}:${message.toolName}`;
  return [`${label} #${String(message.id)} ${message.createdAt}`, ...wrapText(message.content, width).map((text) => `  ${text}`), ""];
}

function eventLines(model: DebugTuiModel, width: number): readonly string[] {
  if (model.events.length === 0) return ["No events loaded yet."];
  const rows = model.events.flatMap((event, index) => {
    const marker = index === model.selectedEventIndex ? "→" : " ";
    const summary = `${marker} ${String(event.sequence ?? "-")} ${event.observedAt ?? ""} ${event.event ?? "event"}`;
    if (model.expandedEvent && index === model.selectedEventIndex) {
      return [summary, ...wrapText(JSON.stringify(event.payload ?? event, null, 2), width).map((line) => `  ${line}`)];
    }
    return [summaryWithPayload(summary, event, width)];
  });
  return rows;
}

function renderSession(session: DebugSessionSummary, index: number, model: DebugTuiModel, width: number): string {
  const selected = session.sessionId === model.selectedSessionId ? "*" : " ";
  const highlighted = index === model.selectedSessionIndex ? "→" : " ";
  const line = `${highlighted}${selected} ${session.sessionId} ${session.profileId} ${session.sessionState}/${session.presenceStatus} ${session.classification} e=${String(session.recentErrorCount)} m=${String(session.messageCount)}`;
  return truncate(line, width);
}

function helpLines(): readonly string[] {
  return [
    "Direct-debug TUI controls:",
    "  ↑/↓ or j/k: move session selection or scroll active body view",
    "  Enter: select highlighted session, or submit input when input is focused",
    "  Tab / Shift-Tab: cycle focus between sessions, body, input",
    "  c/e/t/?: context, events, tools, help views",
    "  x: expand/collapse selected event raw JSON in events view",
    "  r: refresh sessions, context, events, and current view diagnostics",
    "  /: jump to input and start a service slash command",
    "  q or Ctrl-C: quit",
    "",
    "Slash commands such as /status, /new, /reload-mcp, /help are sent to the service router.",
  ];
}

function zipPanels(left: readonly string[], right: readonly string[], leftWidth: number, rightWidth: number, height: number): readonly string[] {
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    lines.push(`${pad(left[index] ?? "", leftWidth)}│${pad(right[index] ?? "", rightWidth)}`);
  }
  return lines;
}

function banner(width: number): string {
  return truncate(" pi-crew direct-debug TUI — high-trust service client, not Den Channels transport ", width);
}

function statusLine(model: DebugTuiModel, width: number): string {
  return truncate(` status: ${model.status}`, width);
}

function footer(model: DebugTuiModel, width: number): string {
  return truncate(` focus=${model.focus} view=${model.view} selected=${model.selectedSessionId ?? "none"} | ? help | q quit`, width);
}

function panelTitle(title: string, width: number): string {
  const text = ` ${title} `;
  return truncate(`${text}${"─".repeat(Math.max(0, width - text.length))}`, width);
}

function scrollHint(start: number, height: number, total: number, width: number): string {
  if (total <= height) return "";
  return truncate(` (${String(start + 1)}-${String(Math.min(start + height, total))}/${String(total)})`, width);
}

function currentScroll(model: DebugTuiModel): number {
  if (model.view === "context") return model.contextScroll;
  if (model.view === "events") return model.eventScroll;
  return model.chatScroll;
}

function summaryWithPayload(summary: string, event: DebugEventRecord, width: number): string {
  const payload = event.payload === undefined ? "" : ` ${JSON.stringify(event.payload)}`;
  return truncate(`${summary}${payload}`, width);
}

function visibleStart(index: number, total: number, height: number): number {
  if (total <= height) return 0;
  return Math.max(0, Math.min(index - Math.floor(height / 2), total - height));
}

function wrapText(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    let rest = rawLine;
    if (rest.length === 0) lines.push("");
    while (rest.length > 0) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
  }
  return lines;
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  const truncated = truncate(text, width);
  return `${truncated}${" ".repeat(Math.max(0, width - truncated.length))}`;
}
