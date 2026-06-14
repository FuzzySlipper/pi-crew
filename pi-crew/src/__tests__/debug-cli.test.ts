/** Tests for direct diagnostic CLI argument and API wiring. */
import { describe, expect, it } from "vitest";
import { parseArgs, runPiCrewDebug } from "../debug-cli.js";

describe("pi-crew-debug CLI", () => {
  it("parses one-shot and event commands", () => {
    expect(parseArgs(["ask", "--session", "sess-prime-coder", "hello", "there"])).toEqual({
      command: "ask",
      session: "sess-prime-coder",
      message: "hello there",
    });
    expect(parseArgs(["events", "--session", "sess-prime-coder", "--limit", "5"])).toEqual({
      command: "events",
      session: "sess-prime-coder",
      limit: 5,
    });
  });

  it("lists sessions and sends diagnostic turns through the debug API", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const output: string[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = String(url).endsWith("/debug/sessions")
        ? { sessions: [{ sessionId: "sess-prime-coder" }] }
        : { sessionId: "sess-prime-coder", turnId: "turn-1", message: "assistant says hi" };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch;

    await runPiCrewDebug({
      baseUrl: "http://localhost:9237",
      args: ["sessions"],
      fetchImpl,
      write: (text) => output.push(text),
    });
    await runPiCrewDebug({
      baseUrl: "http://localhost:9237",
      args: ["ask", "--session", "sess-prime-coder", "hello"],
      fetchImpl,
      write: (text) => output.push(text),
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:9237/debug/sessions",
      "http://localhost:9237/debug/sessions/sess-prime-coder/turn",
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(output[0]).toContain("sess-prime-coder");
    expect(output[1]).toBe("assistant says hi");
  });
});
