import { describe, expect, it } from "vitest";
import { createDenMemoryTools } from "../den-memory-tools.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function firstText(content: readonly unknown[]): string {
  const first = content[0];
  if (typeof first === "object" && first !== null && "text" in first && typeof first.text === "string") return first.text;
  return "";
}

describe("Den Memories runtime-local tools", () => {
  it("maps full-agent manual recall through the Den Memories client", async () => {
    let body: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      body = parseBody(init);
      return Promise.resolve(jsonResponse({ packet_id: "p1", packet_md: "# Recall", root_matches: [], included_nodes: [], skipped: [], warnings: [], provenance: [] }));
    };
    const tools = createDenMemoryTools({
      baseUrl: "http://den-memory.local",
      policyMode: "manual",
      context: {
        agentIdentity: "prime",
        profileId: "prime-profile",
        sessionId: "sess-prime",
        sessionKind: "durable_agent",
        projectId: "pi-crew",
        role: "runner",
      },
    });
    const recall = tools.find((tool) => tool.name === "den_memory_recall");
    expect(recall).toBeDefined();
    const recallTool = recall as NonNullable<typeof recall>;

    try {
      const result = await recallTool.execute("call-1", { query: "memory adapter" });
      expect(firstText(result.content)).toContain("p1");
      expect(body?.runtime_context).toMatchObject({ runtime: "pi_crew", session_kind: "durable_agent", profile_id: "prime-profile" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns typed error details when policy is off", async () => {
    const [recall] = createDenMemoryTools({
      baseUrl: "http://den-memory.local",
      policyMode: "off",
      context: { agentIdentity: "prime", sessionId: "sess", sessionKind: "durable_agent" },
    });
    expect(recall).toBeDefined();
    const firstTool = recall as NonNullable<typeof recall>;
    const result = await firstTool.execute("call-1", { query: "anything" });
    expect(firstText(result.content)).toContain("policy is off");
    expect(result.details).toMatchObject({ ok: false, code: "policy_off" });
  });
});
