import { describe, it, expect } from "vitest";
import type { Profile, Skill, ModelConfig, ToolPolicy } from "../profile.js";

describe("Profile type (compile-time structural checks)", () => {
  it("accepts a minimal profile", () => {
    const p: Profile = {
      id: "test",
      name: "Test Agent",
      description: "A test",
      systemPrompt: "You are a test agent.",
      skills: [],
    };
    expect(p.id).toBe("test");
    expect(p.name).toBe("Test Agent");
    expect(p.skills).toHaveLength(0);
  });

  it("accepts a full profile with skills, modelConfig, and toolPolicy", () => {
    const skill: Skill = {
      name: "debugging",
      description: "Debug things",
      version: "1.2.3",
    };
    const modelConfig: ModelConfig = {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.3,
      maxTokens: 4096,
    };
    const toolPolicy: ToolPolicy = {
      mode: "deny_list",
      deny: ["shell", "network"],
    };
    const p: Profile = {
      id: "full-agent",
      name: "Full Agent",
      description: "Has everything",
      systemPrompt: "You are fully configured.",
      skills: [skill],
      modelConfig,
      toolPolicy,
    };
    expect(p.skills[0]?.name).toBe("debugging");
    expect(p.modelConfig?.provider).toBe("openai");
    expect(p.toolPolicy?.mode).toBe("deny_list");
    expect(p.toolPolicy?.deny).toEqual(["shell", "network"]);
  });

  it("modelConfig and toolPolicy are optional", () => {
    const p: Profile = {
      id: "minimal",
      name: "Minimal",
      description: "Bare bones",
      systemPrompt: "Hello",
      skills: [],
    };
    expect(p.modelConfig).toBeUndefined();
    expect(p.toolPolicy).toBeUndefined();
  });
});

describe("ToolPolicy", () => {
  it("all three modes are valid", () => {
    const allowAll: ToolPolicy = { mode: "allow_all" };
    const allowList: ToolPolicy = {
      mode: "allow_list",
      allow: ["files", "git"],
    };
    const denyList: ToolPolicy = {
      mode: "deny_list",
      deny: ["shell"],
    };
    expect(allowAll.mode).toBe("allow_all");
    expect(allowList.mode).toBe("allow_list");
    expect(denyList.mode).toBe("deny_list");
  });
});
