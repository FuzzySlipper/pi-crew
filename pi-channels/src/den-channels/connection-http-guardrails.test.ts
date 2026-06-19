/**
 * Guardrail tests for the conversation/actuation split in the HTTP
 * Den Channels connection layer.
 *
 * Verifies that:
 * - Active call sites in sendMessage do not use banned gateway routes.
 * - The connection config documents `baseUrl` as conversation-only
 *   and provides explicit `gatewayUrl`/`deliveryUrl` fields.
 *
 * @module pi-channels/__tests__/connection-http-guardrails
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { DenHttpConnectionConfig } from "./connection-types.js";

// ── Banned route strings ──────────────────────────────────────
// These routes are forbidden as active delivery paths.
// They may appear only as tombstoned compat methods,
// never as the primary sendMessage path.

const BANNED_ROUTES: readonly string[] = [
  "/api/gateway/system-messages",
  "/api/gateway/direct-agent-messages",
  "/api/gateway/events",
  "/api/gateway/channel-activity-events",
  "/api/gateway/test-wakes",
];

// ── Constants ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_FILES = [
  "connection-http.ts",
  "connection-http-client.ts",
] as const;

// ── Helpers ────────────────────────────────────────────────────

/**
 * Read a source file and find banned route strings
 * that appear OUTSIDE the `postGatewaySystemMessage` method
 * (which is intentionally retained as a deprecated compat path).
 *
 * We check every line for banned routes. Lines inside the
 * postGatewaySystemMessage method body are exempt because the
 * method itself is @deprecated and retained only as a tombstone.
 */
function findBannedRouteViolations(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: string[] = [];

  // Track whether we're inside the postGatewaySystemMessage method
  let inDeprecatedGatewayMethod = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Detect entry into postGatewaySystemMessage
    if (line.trimStart().startsWith("async postGatewaySystemMessage(")) {
      inDeprecatedGatewayMethod = true;
      continue;
    }

    // Detect exit from the method (next method or closing brace at top level)
    if (inDeprecatedGatewayMethod) {
      // If we see a new method declaration, we've exited the deprecated method
      if (
        line.trimStart().startsWith("async ") ||
        line.trimStart().startsWith("  async ")
      ) {
        inDeprecatedGatewayMethod = false;
      }
      // Otherwise skip this line entirely
      continue;
    }

    // Outside the deprecated method — check for banned routes
    for (const route of BANNED_ROUTES) {
      if (!line.includes(route)) continue;

      const trimmed = line.trimStart();
      // Allow comment-only lines and JSDoc
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.includes("@deprecated")
      ) {
        continue;
      }

      violations.push(`${filePath}:${i + 1}: ${trimmed}`);
    }
  }

  return violations;
}

// ── Tests ─────────────────────────────────────────────────────

describe("HTTP connection route guardrails", () => {
  const sourceDir = resolve(__dirname);

  it("no active code paths outside deprecated methods use banned gateway routes", () => {
    const allViolations: string[] = [];
    for (const file of SOURCE_FILES) {
      allViolations.push(
        ...findBannedRouteViolations(resolve(sourceDir, file)),
      );
    }

    if (allViolations.length > 0) {
      expect.unreachable(
        `Banned gateway routes found in active code:\n${allViolations.join("\n")}`,
      );
    }
  });

  it("sendMessage uses postChannelMessage (not postGatewaySystemMessage)", () => {
    const httpFile = resolve(sourceDir, "connection-http.ts");
    const content = readFileSync(httpFile, "utf-8");

    // The sendMessage method must call postChannelMessage
    const sendMessageBody = content.match(
      /async sendMessage\([^)]+\)[^;]+?\{[^}]+}/s,
    );
    // Check that postChannelMessage appears in sendMessage's implementation
    const sendMessageStart = content.indexOf("async sendMessage(");
    const nextMethodOrEnd = content.indexOf(
      "async ",
      sendMessageStart + "async sendMessage(".length,
    );
    const sendMessageImpl = content.slice(
      sendMessageStart,
      nextMethodOrEnd > sendMessageStart ? nextMethodOrEnd : undefined,
    );

    expect(sendMessageImpl).toContain("postChannelMessage");
    // Should NOT contain postGatewaySystemMessage in the sendMessage method
    expect(sendMessageImpl).not.toContain("postGatewaySystemMessage");
  });

  it("DenHttpConnectionConfig documents baseUrl as conversation-only", () => {
    const configFile = resolve(sourceDir, "connection-types.ts");
    const content = readFileSync(configFile, "utf-8");

    const baseUrlIndex = content.indexOf("readonly baseUrl:");
    expect(baseUrlIndex).toBeGreaterThanOrEqual(0);

    const precedingText = content.slice(
      Math.max(0, baseUrlIndex - 400),
      baseUrlIndex,
    );

    expect(precedingText).toContain("Conversation API only");
    expect(precedingText).toContain("NOT be used as the implicit delivery");
  });

  it("DenHttpConnectionConfig declares gatewayUrl and deliveryUrl fields", () => {
    const configFile = resolve(sourceDir, "connection-types.ts");
    const content = readFileSync(configFile, "utf-8");

    expect(content).toContain("readonly gatewayUrl?");
    expect(content).toContain("readonly deliveryUrl?");
  });

  it("postGatewaySystemMessage is marked @deprecated in source", () => {
    const clientFile = resolve(sourceDir, "connection-http-client.ts");
    const content = readFileSync(clientFile, "utf-8");

    const methodIndex = content.indexOf("async postGatewaySystemMessage(");
    expect(methodIndex).toBeGreaterThanOrEqual(0);

    const precedingText = content.slice(
      Math.max(0, methodIndex - 200),
      methodIndex,
    );

    expect(precedingText).toContain("@deprecated");
  });
});
