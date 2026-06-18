import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

interface BrowserSession {
  readonly sessionId: string;
  readonly profileId: string;
  readonly refs: Map<string, string>;
  process?: ChildProcessWithoutNullStreams;
  cdp?: CdpClient;
  pageWebSocketUrl?: string;
  userDataDir?: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly method?: string;
}

interface CdpWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(event: "open" | "message" | "error" | "close", listener: (event: unknown) => void): void;
}

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface BrowserToolConfig {
  readonly browserBinaryPath?: string;
  readonly pageLoadTimeoutMs?: number;
  readonly cdpTimeoutMs?: number;
}

const sessions = new Map<string, BrowserSession>();
const WS_OPEN = 1;

export function createBrowserTools(input: { readonly sessionId: string; readonly profileId: string }, config: BrowserToolConfig = {}): AgentTool[] {
  const browserBinaryPath = config.browserBinaryPath ?? process.env.PI_CREW_CHROMIUM_PATH ?? "chromium";
  const pageLoadTimeoutMs = config.pageLoadTimeoutMs ?? 8_000;
  const cdpTimeoutMs = config.cdpTimeoutMs ?? 15_000;
  const openSession = createSessionOpener(browserBinaryPath, cdpTimeoutMs);
  return [
    browserNavigateTool(input, openSession, pageLoadTimeoutMs),
    browserSnapshotTool(input, openSession),
    browserClickTool(input, openSession),
    browserTypeTool(input, openSession),
    browserScrollTool(input, openSession),
    browserBackTool(input, openSession),
    browserPressTool(input, openSession),
    browserConsoleTool(input, openSession),
    browserVisionTool(input, openSession),
  ];
}

function browserNavigateTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>, pageLoadTimeoutMs: number): AgentTool {
  return tool("browser_navigate", "Navigate the session-scoped Chromium page to a URL.", { url: stringSchema("HTTP(S) URL to open.") }, ["url"], async (params) => {
    const browser = await openSession(input);
    await browser.call("Page.navigate", { url: stringParam(params, "url") });
    await browser.call("Page.loadEventFired", {}, pageLoadTimeoutMs).catch(() => undefined);
    return ok("navigated", { url: stringParam(params, "url") });
  });
}

function browserSnapshotTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_snapshot", "Return a compact accessibility/DOM snapshot with clickable ref ids like @e0.", {}, [], async () => {
    const browser = await openSession(input);
    const title = await evalString(browser, "document.title");
    const url = await evalString(browser, "location.href");
    const refs = await evalJson<readonly DomRef[]>(browser, DOM_REF_SCRIPT);
    const ax = await browser.call("Accessibility.getFullAXTree", {});
    inputRefs(input).clear();
    refs.forEach((ref, index) => inputRefs(input).set(`@e${String(index)}`, ref.selector));
    const lines = [`title: ${title}`, `url: ${url}`, "", "interactive elements:"];
    refs.forEach((ref, index) => lines.push(`[@e${String(index)}] ${ref.role} ${ref.name}`.trim()));
    lines.push("", "accessibility tree excerpt:", ...axTreeLines(ax).slice(0, 80));
    return ok(lines.join("\n"), { title, url, refs });
  });
}

function browserClickTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_click", "Click an element by ref id from browser_snapshot, e.g. @e0.", { ref: stringSchema("Ref id from browser_snapshot.") }, ["ref"], async (params) => {
    const browser = await openSession(input);
    const selector = requireRef(input, stringParam(params, "ref"));
    await browser.call("Runtime.evaluate", { expression: clickScript(selector), awaitPromise: true });
    return ok(`clicked ${stringParam(params, "ref")}`, { selector });
  });
}

function browserTypeTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_type", "Type text into an input element by ref id from browser_snapshot.", { ref: stringSchema("Ref id."), text: stringSchema("Text to type.") }, ["ref", "text"], async (params) => {
    const browser = await openSession(input);
    const selector = requireRef(input, stringParam(params, "ref"));
    await browser.call("Runtime.evaluate", { expression: typeScript(selector, stringParam(params, "text")), awaitPromise: true });
    return ok(`typed into ${stringParam(params, "ref")}`, { selector });
  });
}

function browserScrollTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_scroll", "Scroll the page up or down.", { direction: { type: "string", enum: ["up", "down"] } }, ["direction"], async (params) => {
    const browser = await openSession(input);
    const direction = stringParam(params, "direction") === "up" ? -1 : 1;
    await browser.call("Runtime.evaluate", { expression: `window.scrollBy(0, ${String(direction * 700)})` });
    return ok("scrolled", { direction });
  });
}

function browserBackTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_back", "Navigate back in browser history.", {}, [], async () => {
    const browser = await openSession(input);
    await browser.call("Runtime.evaluate", { expression: "history.back()" });
    return ok("back", {});
  });
}

function browserPressTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_press", "Press a keyboard key such as Enter, Tab, Escape, ArrowDown.", { key: stringSchema("Key name.") }, ["key"], async (params) => {
    const browser = await openSession(input);
    const key = stringParam(params, "key");
    await browser.call("Input.dispatchKeyEvent", { type: "keyDown", key });
    await browser.call("Input.dispatchKeyEvent", { type: "keyUp", key });
    return ok(`pressed ${key}`, { key });
  });
}

function browserConsoleTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_console", "Evaluate a JavaScript expression and return JSON-serializable result.", { expression: stringSchema("JavaScript expression.") }, [], async (params) => {
    const browser = await openSession(input);
    const expression = stringParam(params, "expression", "document.title");
    const result = await evalJson<unknown>(browser, expression);
    return ok(JSON.stringify(result, null, 2), { result });
  });
}

function browserVisionTool(input: ToolInput, openSession: (input: ToolInput) => Promise<CdpClient>): AgentTool {
  return tool("browser_vision", "Capture a screenshot as base64 PNG for external vision analysis.", {}, [], async () => {
    const browser = await openSession(input);
    const result = await browser.call("Page.captureScreenshot", { format: "png" }) as { readonly data?: string };
    return ok(result.data ?? "", { mimeType: "image/png", base64: result.data ?? "" });
  });
}

type ToolInput = { readonly sessionId: string; readonly profileId: string };
type ToolExecutor = (params: unknown) => Promise<{ content: readonly [{ readonly type: "text"; readonly text: string }]; details: Record<string, unknown> }>;

function tool(name: string, description: string, properties: Record<string, unknown>, required: readonly string[], execute: ToolExecutor): AgentTool {
  return { label: name, name, description, parameters: { type: "object", additionalProperties: false, properties, required }, execute: async (_id, params) => execute(params) };
}

function createSessionOpener(binaryPath: string, cdpTimeoutMs: number): (input: ToolInput) => Promise<CdpClient> {
  return async function session(input: ToolInput): Promise<CdpClient> {
    const existing = sessions.get(input.sessionId);
    if (existing?.cdp !== undefined && existing.process !== undefined && !existing.process.killed) return existing.cdp;
    const next = existing ?? { sessionId: input.sessionId, profileId: input.profileId, refs: new Map<string, string>() };
    next.userDataDir ??= await mkdtemp(join(tmpdir(), `pi-crew-browser-${input.profileId}-`));
    next.process = spawn(binaryPath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${next.userDataDir}`, "--disable-gpu", "--no-first-run", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
    const port = await debuggerPort(next.userDataDir);
    const targets = await fetchJson<readonly CdpTarget[]>(`http://127.0.0.1:${String(port)}/json`);
    const target = targets.find((entry) => entry.type === "page" && entry.url === "about:blank")
      ?? targets.find((entry) => entry.type === "page")
      ?? targets.find((entry) => entry.webSocketDebuggerUrl !== undefined);
    next.pageWebSocketUrl = target?.webSocketDebuggerUrl;
    if (next.pageWebSocketUrl === undefined) throw new Error("Chromium did not expose a page websocket");
    next.cdp = await CdpClient.connect(next.pageWebSocketUrl, cdpTimeoutMs);
    await next.cdp.call("Page.enable", {});
    await next.cdp.call("Runtime.enable", {});
    sessions.set(input.sessionId, next);
    return next.cdp;
  };
}

function inputRefs(input: ToolInput): Map<string, string> {
  const state = sessions.get(input.sessionId);
  if (state === undefined) throw new Error("browser session not started; call browser_snapshot first");
  return state.refs;
}

function requireRef(input: ToolInput, ref: string): string {
  const selector = inputRefs(input).get(ref);
  if (selector === undefined) throw new Error(`unknown browser ref ${ref}; call browser_snapshot first`);
  return selector;
}

async function debuggerPort(userDataDir: string): Promise<number> {
  const path = join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    const port = Number.parseInt(text?.split("\n")[0] ?? "", 10);
    if (Number.isFinite(port)) return port;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chromium DevToolsActivePort");
}

class CdpClient {
  readonly #socket: CdpWebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  readonly #defaultTimeout: number;

  private constructor(socket: CdpWebSocket, defaultTimeout: number) {
    this.#socket = socket;
    this.#defaultTimeout = defaultTimeout;
    socket.addEventListener("message", (event) => {
      this.#onMessage(event);
    });
  }

  static connect(url: string, defaultTimeout = 15_000): Promise<CdpClient> {
    const WebSocketCtor = globalThis.WebSocket as unknown as { new(url: string): CdpWebSocket };
    const socket = new WebSocketCtor(url);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve(new CdpClient(socket, defaultTimeout));
      });
      socket.addEventListener("error", () => {
        reject(new Error("CDP websocket failed to open"));
      });
    });
  }

  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.#socket.readyState !== WS_OPEN) throw new Error("CDP websocket is not open");
    const timeout = timeoutMs ?? this.#defaultTimeout;
    const id = this.#nextId;
    this.#nextId += 1;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP method timed out: ${method}`));
      }, timeout);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  #onMessage(event: unknown): void {
    const data = eventData(event);
    if (data === undefined) return;
    const message = JSON.parse(data) as CdpResponse;
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "CDP error"));
    else pending.resolve(message.result ?? {});
  }
}

interface DomRef { readonly selector: string; readonly role: string; readonly name: string }
const DOM_REF_SCRIPT = `Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[tabindex]')).slice(0,80).map((el,i)=>{ if(!el.dataset.piCrewRef) el.dataset.piCrewRef='e'+i; return {selector:'[data-pi-crew-ref="'+el.dataset.piCrewRef+'"]', role:el.getAttribute('role')||el.tagName.toLowerCase(), name:(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('title')||el.href||'').trim().slice(0,120)} })`;

async function evalString(browser: CdpClient, expression: string): Promise<string> {
  const value = await evalJson<unknown>(browser, expression);
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function evalJson<T>(browser: CdpClient, expression: string): Promise<T> {
  const result = await browser.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as { readonly result?: { readonly value?: T } };
  return result.result?.value as T;
}

function axTreeLines(value: unknown): string[] {
  const nodes = (value as { readonly nodes?: readonly { readonly role?: { readonly value?: string }; readonly name?: { readonly value?: string } }[] }).nodes ?? [];
  return nodes.map((node) => `${node.role?.value ?? "node"}: ${node.name?.value ?? ""}`).filter((line) => line.trim().length > 1);
}

function clickScript(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)})?.click()`;
}

function typeScript(selector: string, text: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing element'); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); })()`;
}

function stringParam(params: unknown, name: string, fallback?: string): string {
  const value = typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>)[name] : undefined;
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing string parameter: ${name}`);
}

function stringSchema(description: string): Record<string, unknown> { return { type: "string", description }; }
function ok(text: string, details: Record<string, unknown>) { return { content: [{ type: "text" as const, text }], details: { ok: true, ...details } }; }
async function fetchJson<T>(url: string): Promise<T> { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${String(response.status)}`); return await response.json() as T; }
function eventData(event: unknown): string | undefined { const data = (event as { readonly data?: unknown }).data; return typeof data === "string" ? data : undefined; }
