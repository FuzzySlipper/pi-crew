#!/usr/bin/env -S tsx
/** Minimal direct diagnostic CLI for pi-crew service sessions. */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface DebugCliOptions {
  readonly baseUrl: string;
  readonly args: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly write?: (text: string) => void;
}

interface ParsedCommand {
  readonly command: "sessions" | "events" | "ask" | "chat" | "help";
  readonly session?: string;
  readonly message?: string;
  readonly limit?: number;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:9237";

export async function runPiCrewDebug(options: DebugCliOptions): Promise<number> {
  const parsed = parseArgs(options.args);
  const write = options.write ?? ((text) => output.write(`${text}\n`));
  const fetcher = options.fetchImpl ?? fetch;
  if (parsed.command === "help") {
    write(usage());
    return 0;
  }
  if (parsed.command === "sessions") {
    write(JSON.stringify(await requestJson(fetcher, `${options.baseUrl}/debug/sessions`), null, 2));
    return 0;
  }
  if (parsed.command === "events") {
    const session = requireSession(parsed);
    const limit = parsed.limit ?? 50;
    write(
      JSON.stringify(
        await requestJson(
          fetcher,
          `${options.baseUrl}/debug/sessions/${encodeURIComponent(session)}/events?limit=${String(limit)}`,
        ),
        null,
        2,
      ),
    );
    return 0;
  }
  if (parsed.command === "ask") {
    const session = requireSession(parsed);
    const message = requireMessage(parsed);
    const response = await postTurn(fetcher, options.baseUrl, session, message);
    write(renderTurnResponse(response));
    return 0;
  }
  await chat(fetcher, options.baseUrl, requireSession(parsed), write);
  return 0;
}

export function parseArgs(args: readonly string[]): ParsedCommand {
  const [command = "help", ...rest] = args;
  if (command === "sessions") return { command };
  if (command === "help" || command === "--help" || command === "-h") return { command: "help" };
  if (command === "events") {
    const session = readFlag(rest, "--session") ?? rest[0];
    const rawLimit = readFlag(rest, "--limit");
    return { command, session, limit: rawLimit === undefined ? undefined : Number(rawLimit) };
  }
  if (command === "ask") {
    const session = readFlag(rest, "--session");
    const messageParts = rest.filter(
      (arg, index) => arg !== "--session" && rest[index - 1] !== "--session",
    );
    return { command, session, message: messageParts.join(" ").trim() };
  }
  if (command === "chat") {
    return { command, session: readFlag(rest, "--session") ?? rest[0] };
  }
  throw new DebugCliError(`Unknown command: ${command}`);
}

async function chat(
  fetcher: typeof fetch,
  baseUrl: string,
  session: string,
  write: (text: string) => void,
): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    write(`Diagnostic chat for ${session}. Ctrl-D to exit.`);
    for (;;) {
      const message = await rl.question("> ");
      if (message.trim().length === 0) continue;
      write(renderTurnResponse(await postTurn(fetcher, baseUrl, session, message)));
    }
  } catch (error: unknown) {
    if (isReadlineAbort(error)) return;
    throw error;
  } finally {
    rl.close();
  }
}

async function postTurn(
  fetcher: typeof fetch,
  baseUrl: string,
  session: string,
  message: string,
): Promise<Record<string, unknown>> {
  return requestJson(fetcher, `${baseUrl}/debug/sessions/${encodeURIComponent(session)}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      contextDiagnostics: true,
      emitDenVisibility: false,
      metadata: { source: "direct-debug-cli" },
    }),
  });
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, init);
  const text = await response.text();
  const parsed = text.trim().length === 0 ? {} : (JSON.parse(text) as unknown);
  if (!response.ok) throw new DebugCliError(`HTTP ${String(response.status)} from ${url}: ${text}`);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new DebugCliError(`Expected JSON object from ${url}`);
}

function renderTurnResponse(response: Record<string, unknown>): string {
  const message = response["message"];
  if (typeof message === "string" && message.trim().length > 0) return message;
  return JSON.stringify(response, null, 2);
}

function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function requireSession(command: ParsedCommand): string {
  if (command.session !== undefined && command.session.trim().length > 0) return command.session;
  throw new DebugCliError(`--session is required for ${command.command}`);
}

function requireMessage(command: ParsedCommand): string {
  if (command.message !== undefined && command.message.trim().length > 0) return command.message;
  throw new DebugCliError("message is required for ask");
}

function isReadlineAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function usage(): string {
  return [
    "pi-crew-debug sessions",
    "pi-crew-debug events --session <sessionId> [--limit 50]",
    "pi-crew-debug ask --session <sessionId> <message>",
    "pi-crew-debug chat --session <sessionId>",
    "",
    "Known limitation: /debug/* is an unauthenticated high-trust LAN/local diagnostic surface.",
  ].join("\n");
}

export class DebugCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebugCliError";
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPiCrewDebug({
    baseUrl: process.env["PI_CREW_DEBUG_URL"] ?? DEFAULT_BASE_URL,
    args: process.argv.slice(2),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
