/** Testable state model and keyboard mapping for the direct-debug full-screen TUI. */
import type {
  DebugEventRecord,
  DebugMessageRecord,
  DebugSessionSummary,
} from "./debug-api-client.js";

export type DebugTuiFocus = "sessions" | "body" | "input";
export type DebugTuiView = "chat" | "context" | "events" | "tools" | "help";

export interface DebugTranscriptLine {
  readonly role: "operator" | "assistant" | "system";
  readonly text: string;
}

export interface DebugTuiModel {
  readonly sessions: readonly DebugSessionSummary[];
  readonly selectedSessionIndex: number;
  readonly selectedSessionId: string | null;
  readonly focus: DebugTuiFocus;
  readonly view: DebugTuiView;
  readonly status: string;
  readonly input: string;
  readonly transcript: readonly DebugTranscriptLine[];
  readonly contextMessages: readonly DebugMessageRecord[];
  readonly events: readonly DebugEventRecord[];
  readonly selectedEventIndex: number;
  readonly expandedEvent: boolean;
  readonly toolsText: string;
  readonly chatScroll: number;
  readonly contextScroll: number;
  readonly eventScroll: number;
  readonly busy: boolean;
  readonly shouldQuit: boolean;
  readonly refreshRequested: boolean;
  readonly submitRequested: string | null;
}

export type DebugTuiAction =
  | { readonly type: "sessionsLoaded"; readonly sessions: readonly DebugSessionSummary[]; readonly preferredSessionId?: string }
  | { readonly type: "contextLoaded"; readonly messages: readonly DebugMessageRecord[]; readonly messageCount: number }
  | { readonly type: "eventsLoaded"; readonly events: readonly DebugEventRecord[] }
  | { readonly type: "toolsLoaded"; readonly tools: unknown }
  | { readonly type: "turnStarted"; readonly message: string }
  | { readonly type: "turnCompleted"; readonly message: string; readonly turnId: string; readonly events: readonly unknown[] }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "selectNext" }
  | { readonly type: "selectPrevious" }
  | { readonly type: "activateSelection" }
  | { readonly type: "focusNext" }
  | { readonly type: "focusPrevious" }
  | { readonly type: "setView"; readonly view: DebugTuiView }
  | { readonly type: "scrollDown" }
  | { readonly type: "scrollUp" }
  | { readonly type: "pageDown" }
  | { readonly type: "pageUp" }
  | { readonly type: "toggleEventExpanded" }
  | { readonly type: "insertText"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "submitInput" }
  | { readonly type: "requestRefresh" }
  | { readonly type: "clearTransient" }
  | { readonly type: "quit" };

export function createDebugTuiModel(initialSessionId?: string): DebugTuiModel {
  return {
    sessions: [],
    selectedSessionIndex: 0,
    selectedSessionId: initialSessionId ?? null,
    focus: "sessions",
    view: "chat",
    status: "connecting to direct-debug API",
    input: "",
    transcript: [],
    contextMessages: [],
    events: [],
    selectedEventIndex: 0,
    expandedEvent: false,
    toolsText: "",
    chatScroll: 0,
    contextScroll: 0,
    eventScroll: 0,
    busy: false,
    shouldQuit: false,
    refreshRequested: false,
    submitRequested: null,
  };
}

export function reduceDebugTuiModel(model: DebugTuiModel, action: DebugTuiAction): DebugTuiModel {
  switch (action.type) {
    case "sessionsLoaded":
      return applySessions(model, action.sessions, action.preferredSessionId);
    case "contextLoaded":
      return { ...model, contextMessages: action.messages, status: `loaded ${String(action.messages.length)} of ${String(action.messageCount)} context message(s)`, view: model.view === "help" ? "context" : model.view };
    case "eventsLoaded":
      return { ...model, events: action.events, selectedEventIndex: clamp(model.selectedEventIndex, 0, Math.max(0, action.events.length - 1)), status: `loaded ${String(action.events.length)} recent event(s)` };
    case "toolsLoaded":
      return { ...model, toolsText: JSON.stringify(action.tools, null, 2), status: "loaded tool/context diagnostics", view: "tools" };
    case "turnStarted":
      return { ...model, busy: true, input: "", submitRequested: null, transcript: [...model.transcript, { role: "operator", text: action.message }], status: "sending turn through service direct-debug API" };
    case "turnCompleted":
      return { ...model, busy: false, transcript: [...model.transcript, { role: "assistant", text: action.message }], events: action.events.map((payload) => ({ payload })), status: `turn ${action.turnId} completed`, view: "chat" };
    case "error":
      return { ...model, busy: false, status: action.message };
    case "selectNext":
      return selectSession(model, 1);
    case "selectPrevious":
      return selectSession(model, -1);
    case "activateSelection":
      return activateSelectedSession(model);
    case "focusNext":
      return { ...model, focus: nextFocus(model.focus, 1) };
    case "focusPrevious":
      return { ...model, focus: nextFocus(model.focus, -1) };
    case "setView":
      return { ...model, view: action.view, focus: action.view === "chat" ? model.focus : "body", expandedEvent: action.view === "events" ? model.expandedEvent : false };
    case "scrollDown":
      return scroll(model, 1);
    case "scrollUp":
      return scroll(model, -1);
    case "pageDown":
      return scroll(model, 8);
    case "pageUp":
      return scroll(model, -8);
    case "toggleEventExpanded":
      return { ...model, expandedEvent: model.view === "events" ? !model.expandedEvent : model.expandedEvent };
    case "insertText":
      return { ...model, focus: "input", input: `${model.input}${action.text}` };
    case "backspace":
      return { ...model, input: model.input.slice(0, -1), focus: "input" };
    case "submitInput":
      return submitInput(model);
    case "requestRefresh":
      return { ...model, refreshRequested: true, status: "refresh requested" };
    case "clearTransient":
      return { ...model, refreshRequested: false, submitRequested: null };
    case "quit":
      return { ...model, shouldQuit: true };
  }
}

export function actionFromKey(data: string, model: DebugTuiModel): DebugTuiAction | null {
  if (data === "\u0003") return { type: "quit" };
  if (data === "\t") return { type: "focusNext" };
  if (data === "\x1b[Z") return { type: "focusPrevious" };
  if (data === "\x1b" || data === "\x1b\x1b") return model.focus === "input" ? { type: "focusNext" } : { type: "setView", view: "chat" };
  if (data === "\r" || data === "\n") return model.focus === "sessions" ? { type: "activateSelection" } : { type: "submitInput" };
  if (data === "\x7f" || data === "\b") return { type: "backspace" };
  if (data === "\x1b[A" || (data === "k" && model.focus !== "input")) return model.focus === "sessions" ? { type: "selectPrevious" } : { type: "scrollUp" };
  if (data === "\x1b[B" || (data === "j" && model.focus !== "input")) return model.focus === "sessions" ? { type: "selectNext" } : { type: "scrollDown" };
  if (data === "\x1b[5~") return { type: "pageUp" };
  if (data === "\x1b[6~") return { type: "pageDown" };
  if (model.focus !== "input") {
    if (data === "q") return { type: "quit" };
    if (data === "r") return { type: "requestRefresh" };
    if (data === "c") return { type: "setView", view: "context" };
    if (data === "e") return { type: "setView", view: "events" };
    if (data === "t") return { type: "setView", view: "tools" };
    if (data === "?") return { type: "setView", view: "help" };
    if (data === "x") return { type: "toggleEventExpanded" };
    if (data === "i") return { type: "focusNext" };
    if (data === "/") return { type: "insertText", text: "/" };
  }
  return printableText(data) === null ? null : { type: "insertText", text: data };
}

export function activeSession(model: DebugTuiModel): DebugSessionSummary | null {
  return model.sessions.find((session) => session.sessionId === model.selectedSessionId) ?? null;
}

function applySessions(model: DebugTuiModel, sessions: readonly DebugSessionSummary[], preferred?: string): DebugTuiModel {
  const preferredSessionId = preferred ?? model.selectedSessionId;
  const preferredIndex = preferredSessionId === null
    ? -1
    : sessions.findIndex((session) => session.sessionId === preferredSessionId);
  const selectedSessionIndex = preferredIndex >= 0 ? preferredIndex : clamp(model.selectedSessionIndex, 0, Math.max(0, sessions.length - 1));
  const selectedSessionId = sessions[selectedSessionIndex]?.sessionId ?? preferredSessionId ?? null;
  return { ...model, sessions, selectedSessionIndex, selectedSessionId, status: `loaded ${String(sessions.length)} session(s)` };
}

function selectSession(model: DebugTuiModel, delta: number): DebugTuiModel {
  if (model.sessions.length === 0) return model;
  const selectedSessionIndex = wrap(model.selectedSessionIndex + delta, model.sessions.length);
  return { ...model, selectedSessionIndex, status: `highlighted ${model.sessions[selectedSessionIndex]?.sessionId ?? "unknown"}` };
}

function activateSelectedSession(model: DebugTuiModel): DebugTuiModel {
  const selected = model.sessions[model.selectedSessionIndex];
  if (selected === undefined) return { ...model, status: "no session available" };
  return { ...model, selectedSessionId: selected.sessionId, status: `selected ${selected.sessionId}`, contextMessages: [], events: [], toolsText: "", refreshRequested: true, contextScroll: 0, eventScroll: 0, chatScroll: 0 };
}

function nextFocus(focus: DebugTuiFocus, delta: number): DebugTuiFocus {
  const order: readonly DebugTuiFocus[] = ["sessions", "body", "input"];
  return order[wrap(order.indexOf(focus) + delta, order.length)] ?? "sessions";
}

function scroll(model: DebugTuiModel, delta: number): DebugTuiModel {
  if (model.view === "events") return { ...model, eventScroll: Math.max(0, model.eventScroll + delta), selectedEventIndex: clamp(model.selectedEventIndex + delta, 0, Math.max(0, model.events.length - 1)) };
  if (model.view === "context") return { ...model, contextScroll: Math.max(0, model.contextScroll + delta) };
  return { ...model, chatScroll: Math.max(0, model.chatScroll + delta) };
}

function submitInput(model: DebugTuiModel): DebugTuiModel {
  const message = model.input.trim();
  if (message.length === 0) return { ...model, status: "input is empty", focus: "input" };
  if (model.selectedSessionId === null) return { ...model, status: "select a session before sending", focus: "sessions" };
  return { ...model, submitRequested: message, focus: "input" };
}

function printableText(data: string): string | null {
  if (data.length === 0) return null;
  for (const char of data) {
    const code = char.charCodeAt(0);
    if (code < 32 && char !== "\n" && char !== "\t") return null;
    if (code === 127) return null;
  }
  return data;
}

function wrap(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
