import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve, relative } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { localModelCallableToolNames } from "./local-tool-catalog.js";

const execFileAsync = promisify(execFile);

export const localCodeToolNames = localModelCallableToolNames("local") as readonly [
  "read_file",
  "write_file",
  "search_files",
  "terminal",
  "git_status",
  "git_diff",
];

type LocalCodeToolName = (typeof localCodeToolNames)[number];

export interface LocalCodeToolConfig {
  readonly rootPath?: string;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly maxBufferBytes?: number;
}

export function createLocalCodeTools(config: LocalCodeToolConfig = {}): AgentTool[] {
  const rootPath = resolve(
    config.rootPath ?? process.env.PI_CREW_LOCAL_TOOL_ROOT ?? "/home/dev/pi-crew",
  );
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000;
  const maxOutputChars = config.maxOutputChars ?? 8_000;
  const maxBufferBytes = config.maxBufferBytes ?? 512_000;
  return localCodeToolNames.map((name) =>
    createLocalCodeTool(name, rootPath, defaultTimeoutMs, maxOutputChars, maxBufferBytes),
  );
}

function createLocalCodeTool(
  name: LocalCodeToolName,
  rootPath: string,
  defaultTimeoutMs: number,
  maxOutputChars: number,
  maxBufferBytes: number,
): AgentTool {
  const truncate = (text: string): string => {
    if (text.length <= maxOutputChars) return text;
    return `${text.slice(0, maxOutputChars)}… [truncated]`;
  };
  switch (name) {
    case "read_file":
      return readFileTool(rootPath, truncate);
    case "write_file":
      return writeFileTool(rootPath);
    case "search_files":
      return searchFilesTool(rootPath);
    case "terminal":
      return terminalTool(rootPath, defaultTimeoutMs, maxBufferBytes, truncate);
    case "git_status":
      return gitStatusTool(rootPath, defaultTimeoutMs, truncate);
    case "git_diff":
      return gitDiffTool(rootPath, defaultTimeoutMs, truncate);
  }
}

function readFileTool(rootPath: string, truncate: (text: string) => string): AgentTool {
  return {
    label: "Read file",
    name: "read_file",
    description: "Read a UTF-8 text file under the delegated workdir root.",
    parameters: objectSchema({ path: stringSchema("Path under the workdir root.") }, ["path"]),
    execute: async (_toolCallId, params) => {
      const path = resolveInsideRoot(rootPath, stringParam(params, "path"));
      const text = await fs.readFile(path, "utf8");
      return textResult(truncate(text), { ok: true, path });
    },
  };
}

function writeFileTool(rootPath: string): AgentTool {
  return {
    label: "Write file",
    name: "write_file",
    description: "Write a UTF-8 text file under the delegated workdir root.",
    parameters: objectSchema(
      {
        path: stringSchema("Path under the workdir root."),
        content: stringSchema("Complete file content."),
      },
      ["path", "content"],
    ),
    execute: async (_toolCallId, params) => {
      const path = resolveInsideRoot(rootPath, stringParam(params, "path"));
      await fs.mkdir(resolve(path, ".."), { recursive: true });
      await fs.writeFile(path, stringParam(params, "content"), "utf8");
      return textResult(`wrote ${relative(rootPath, path)}`, { ok: true, path });
    },
  };
}

function searchFilesTool(rootPath: string): AgentTool {
  return {
    label: "Search files",
    name: "search_files",
    description: "Search text files under the delegated workdir root by substring or regex.",
    parameters: objectSchema(
      {
        pattern: stringSchema("Substring or JavaScript regex pattern."),
        path: stringSchema("Optional subdirectory under the workdir root."),
        limit: { type: "integer", default: 50 },
      },
      ["pattern"],
    ),
    execute: async (_toolCallId, params) => {
      const start = resolveInsideRoot(rootPath, stringParam(params, "path", "."));
      const pattern = new RegExp(stringParam(params, "pattern"));
      const limit = numberParam(params, "limit", 50);
      const matches = await searchTextFiles(rootPath, start, pattern, limit);
      return textResult(matches.join("\n"), { ok: true, matches });
    },
  };
}

function terminalTool(
  rootPath: string,
  defaultTimeoutMs: number,
  maxBufferBytes: number,
  truncate: (text: string) => string,
): AgentTool {
  return {
    label: "Run terminal command",
    name: "terminal",
    description: "Run a bounded shell command inside the delegated workdir root.",
    parameters: objectSchema(
      {
        command: stringSchema("Shell command to run."),
        workdir: stringSchema("Optional workdir under the root."),
        timeoutMs: { type: "integer", default: defaultTimeoutMs },
      },
      ["command"],
    ),
    execute: async (_toolCallId, params) => {
      const cwd = resolveInsideRoot(rootPath, stringParam(params, "workdir", "."));
      const timeout = Math.min(
        numberParam(params, "timeoutMs", defaultTimeoutMs),
        defaultTimeoutMs,
      );
      const result = await execFileAsync("bash", ["-lc", stringParam(params, "command")], {
        cwd,
        timeout,
        maxBuffer: maxBufferBytes,
      });
      const output = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
      return textResult(truncate(output), {
        ok: true,
        cwd,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    },
  };
}

function gitStatusTool(
  rootPath: string,
  defaultTimeoutMs: number,
  truncate: (text: string) => string,
): AgentTool {
  return {
    label: "Git status",
    name: "git_status",
    description: "Run git status --short --branch inside the delegated workdir root.",
    parameters: objectSchema({ workdir: stringSchema("Optional workdir under the root.") }, []),
    execute: async (_toolCallId, params) =>
      runGit(rootPath, params, ["status", "--short", "--branch"], defaultTimeoutMs, truncate),
  };
}

function gitDiffTool(
  rootPath: string,
  defaultTimeoutMs: number,
  truncate: (text: string) => string,
): AgentTool {
  return {
    label: "Git diff",
    name: "git_diff",
    description: "Run git diff --stat inside the delegated workdir root.",
    parameters: objectSchema({ workdir: stringSchema("Optional workdir under the root.") }, []),
    execute: async (_toolCallId, params) =>
      runGit(rootPath, params, ["diff", "--stat"], defaultTimeoutMs, truncate),
  };
}

async function runGit(
  rootPath: string,
  params: unknown,
  args: readonly string[],
  defaultTimeoutMs: number,
  truncate: (text: string) => string,
) {
  const cwd = resolveInsideRoot(rootPath, stringParam(params, "workdir", "."));
  const result = await execFileAsync("git", [...args], { cwd, timeout: defaultTimeoutMs });
  const output = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
  return textResult(truncate(output), {
    ok: true,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function searchTextFiles(
  rootPath: string,
  start: string,
  pattern: RegExp,
  limit: number,
): Promise<string[]> {
  const found: string[] = [];
  async function visit(path: string): Promise<void> {
    if (found.length >= limit) return;
    const entries = await fs.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= limit || entry.name === "node_modules" || entry.name === ".git") continue;
      const child = resolve(path, entry.name);
      if (!isInside(rootPath, child)) continue;
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = await fs.readFile(child, "utf8").catch(() => undefined);
      if (text !== undefined && pattern.test(text)) found.push(relative(rootPath, child));
    }
  }
  await visit(start);
  return found;
}

function resolveInsideRoot(rootPath: string, requested: string): string {
  const path = resolve(rootPath, requested);
  if (!isInside(rootPath, path)) throw new Error(`path escapes delegated root: ${requested}`);
  return path;
}

function isInside(rootPath: string, path: string): boolean {
  const rel = relative(rootPath, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function stringParam(params: unknown, name: string, fallback?: string): string {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    const value = (params as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`missing string parameter: ${name}`);
}

function numberParam(params: unknown, name: string, fallback: number): number {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    const value = (params as Record<string, unknown>)[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

