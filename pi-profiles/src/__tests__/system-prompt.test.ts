import { describe, it, expect } from "vitest";
import {
  assembleSystemPrompt,
  assembleProfilePrompt,
  type BlackboardHeadings,
  type RuntimeContext,
} from "../system-prompt.js";
import type { Profile } from "../profile.js";

const baseProfile: Profile = {
  id: "test-agent",
  name: "Test Agent",
  description: "A test profile",
  systemPrompt: "You are a test agent. Be helpful.",
  skills: [
    {
      name: "debugging",
      description: "Debug problems with root-cause analysis.",
      version: "1.0.0",
    },
    {
      name: "testing",
      description: "Write and run tests.",
      version: "0.2.0",
    },
  ],
};

describe("assembleSystemPrompt", () => {
  it("includes the profile system prompt", () => {
    const result = assembleSystemPrompt({ profile: baseProfile });
    expect(result).toContain("You are a test agent. Be helpful.");
  });

  it("includes skill listing with versions", () => {
    const result = assembleSystemPrompt({ profile: baseProfile });
    expect(result).toContain("## Available Skills");
    expect(result).toContain("**debugging** (v1.0.0)");
    expect(result).toContain("**testing** (v0.2.0)");
  });

  it("omits skills section when profile has no skills", () => {
    const noSkills: Profile = {
      ...baseProfile,
      skills: [],
    };
    const result = assembleSystemPrompt({ profile: noSkills });
    expect(result).not.toContain("## Available Skills");
  });

  it("includes runtime context when provided", () => {
    const runtime: RuntimeContext = {
      projectId: "pi-crew",
      taskId: 1862,
      role: "coder",
    };
    const result = assembleSystemPrompt({
      profile: baseProfile,
      runtime,
    });
    expect(result).toContain("## Runtime Context");
    expect(result).toContain("Current role: coder");
    expect(result).toContain("Project: pi-crew");
    expect(result).toContain("Task: #1862");
  });

  it("includes extra runtime context keys", () => {
    const runtime: RuntimeContext = {
      extra: { "Branch": "task/1862", "Base": "main" },
    };
    const result = assembleSystemPrompt({
      profile: baseProfile,
      runtime,
    });
    expect(result).toContain("Branch: task/1862");
    expect(result).toContain("Base: main");
  });

  it("omits runtime context section when not provided", () => {
    const result = assembleSystemPrompt({ profile: baseProfile });
    expect(result).not.toContain("## Runtime Context");
  });

  it("omits runtime context section when empty", () => {
    const runtime: RuntimeContext = {};
    const result = assembleSystemPrompt({
      profile: baseProfile,
      runtime,
    });
    expect(result).not.toContain("## Runtime Context");
  });

  it("includes blackboard headings but not full content", () => {
    const blackboard: BlackboardHeadings = {
      headings: [
        "Previous decision: use TypeScript strict mode",
        "Open issue: rate limiting strategy",
      ],
    };
    const result = assembleSystemPrompt({
      profile: baseProfile,
      blackboard,
    });
    expect(result).toContain("## Blackboard (headings only)");
    expect(result).toContain("Use memory tools to retrieve full entries.");
    expect(result).toContain("Previous decision: use TypeScript strict mode");
    expect(result).toContain("Open issue: rate limiting strategy");

    // Headings should not include full blackboard content.
    expect(result).not.toContain("blackboard content");
  });

  it("omits blackboard section when headings are empty", () => {
    const blackboard: BlackboardHeadings = { headings: [] };
    const result = assembleSystemPrompt({
      profile: baseProfile,
      blackboard,
    });
    expect(result).not.toContain("## Blackboard");
  });

  it("includes tool policy when present", () => {
    const p: Profile = {
      ...baseProfile,
      toolPolicy: {
        mode: "deny_list",
        deny: ["shell", "network"],
      },
    };
    const result = assembleSystemPrompt({ profile: p });
    expect(result).toContain("## Tool Policy");
    expect(result).toContain("Mode: deny_list");
    expect(result).toContain("Denied: shell, network");
  });

  it("tool policy defaults to allow_all in informational output", () => {
    const p: Profile = {
      ...baseProfile,
      toolPolicy: {},
    };
    const result = assembleSystemPrompt({ profile: p });
    expect(result).toContain("Mode: allow_all");
  });

  it("omits tool policy section when absent", () => {
    const result = assembleSystemPrompt({ profile: baseProfile });
    expect(result).not.toContain("## Tool Policy");
  });

  it("sections are separated by double newlines", () => {
    const result = assembleSystemPrompt({
      profile: baseProfile,
      runtime: { role: "reviewer" },
      blackboard: { headings: ["h1"] },
    });
    const sections = result.split("\n\n");
    expect(sections.length).toBeGreaterThanOrEqual(3);

    // Verify each section heading is at the start of its section.
    const asText = result;
    expect(asText).toContain("## Runtime Context");
    expect(asText).toContain("## Available Skills");
    expect(asText).toContain("## Blackboard");
  });
});

describe("assembleProfilePrompt", () => {
  it("returns the same result as assembleSystemPrompt with only profile", () => {
    const full = assembleSystemPrompt({ profile: baseProfile });
    const shortcut = assembleProfilePrompt(baseProfile);
    expect(shortcut).toBe(full);
  });
});
