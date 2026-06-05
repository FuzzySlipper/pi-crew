/**
 * Tests for the MCP tool → AgentTool converter.
 *
 * Covers: basic conversion, all JSON Schema types, required/optional,
 * descriptions, enum, defaults, items, unknown field preservation,
 * annotation mapping, and the batch convertTools function.
 *
 * @module pi-mcp/tool-converter.test
 */

import { describe, it, expect } from "vitest";
import { convertTool, convertTools } from "./tool-converter.js";
import type { MCPTool } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeMcpTool(overrides: Partial<MCPTool> = {}): MCPTool {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    ...overrides,
  };
}

// ── Basic conversion ─────────────────────────────────────────────

describe("convertTool", () => {
  it("converts a minimal tool", () => {
    const tool = makeMcpTool({ name: "minimal" });
    const result = convertTool(tool);

    expect(result.name).toBe("minimal");
    expect(result.description).toBe("A test tool");
    expect(result.inputSchema).toEqual({ type: "object", properties: {} });
    expect(result.annotations).toBeUndefined();
  });

  it("falls back to auto-generated description when none provided", () => {
    const tool = makeMcpTool({ description: undefined });
    const result = convertTool(tool);

    expect(result.description).toBe("MCP tool: test_tool");
  });

  it("passes through tool description", () => {
    const tool = makeMcpTool({ description: "Creates a task" });
    const result = convertTool(tool);

    expect(result.description).toBe("Creates a task");
  });

  it("returns undefined annotations when empty", () => {
    const tool = makeMcpTool({ annotations: {} });
    const result = convertTool(tool);

    expect(result.annotations).toBeUndefined();
  });
});

// ── Schema types ──────────────────────────────────────────────────

describe("convertTool — schema types", () => {
  it("handles string property", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { name: { type: "string", description: "The name" } },
        required: ["name"],
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.name).toMatchObject({ type: "string", description: "The name" });
    expect(result.inputSchema.required).toEqual(["name"]);
  });

  it("handles number property", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { count: { type: "number" } },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.count).toMatchObject({ type: "number" });
  });

  it("handles integer property", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { age: { type: "integer" } },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.age).toMatchObject({ type: "integer" });
  });

  it("handles boolean property", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { verbose: { type: "boolean" } },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.verbose).toMatchObject({ type: "boolean" });
  });

  it("handles array property with items", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;
    const tags = props.tags as Record<string, unknown>;

    expect(tags.type).toBe("array");
    expect(tags.items).toMatchObject({ type: "string" });
  });

  it("handles object property (nested)", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: {
          config: {
            type: "object",
            properties: { key: { type: "string" } },
          },
        },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;
    const cfg = props.config as Record<string, unknown>;

    expect(cfg.type).toBe("object");
  });

  it("defaults to string for unrecognized type", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { weird: { type: "unknown_type" } },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.weird).toMatchObject({ type: "string" });
  });

  it("defaults to string when type is absent", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { noType: {} },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.noType).toMatchObject({ type: "string" });
  });
});

// ── Optional / required ───────────────────────────────────────────

describe("convertTool — required/optional", () => {
  it("preserves required array", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
      },
    });

    const result = convertTool(tool);

    expect(result.inputSchema.required).toEqual(["a"]);
  });

  it("omits required when absent", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { a: { type: "string" } },
      },
    });

    const result = convertTool(tool);

    expect(result.inputSchema.required).toBeUndefined();
  });
});

// ── Enum / default ───────────────────────────────────────────────

describe("convertTool — enum and default", () => {
  it("preserves enum values", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { priority: { type: "string", enum: ["low", "medium", "high"] } },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.priority).toMatchObject({
      type: "string",
      enum: ["low", "medium", "high"],
    });
  });

  it("preserves default value", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: { limit: { type: "number", default: 20 } },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;

    expect(props.limit).toMatchObject({ type: "number", default: 20 });
  });
});

// ── Unknown field preservation ────────────────────────────────────

describe("convertTool — unknown fields", () => {
  it("preserves unknown top-level schema keys", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
        "x-custom": "extension",
      },
    });

    const result = convertTool(tool);

    expect(result.inputSchema.additionalProperties).toBe(false);
    expect(result.inputSchema["x-custom"]).toBe("extension");
  });

  it("preserves unknown property-level keys", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            format: "email",
            minLength: 1,
          },
        },
      },
    });

    const result = convertTool(tool);
    const props = result.inputSchema.properties as Record<string, unknown>;
    const nameProp = props.name as Record<string, unknown>;

    expect(nameProp.format).toBe("email");
    expect(nameProp.minLength).toBe(1);
  });
});

// ── Annotations ──────────────────────────────────────────────────

describe("convertTool — annotations", () => {
  it("maps all annotation fields", () => {
    const tool = makeMcpTool({
      annotations: {
        title: "My Tool",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });

    const result = convertTool(tool);

    expect(result.annotations).toEqual({
      title: "My Tool",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("filters out undefined annotation fields", () => {
    const tool = makeMcpTool({
      annotations: {
        readOnlyHint: true,
        destructiveHint: undefined,
      },
    });

    const result = convertTool(tool);

    expect(result.annotations).toEqual({ readOnlyHint: true });
  });
});

// ── Batch conversion ─────────────────────────────────────────────

describe("convertTools", () => {
  it("converts an empty array", () => {
    expect(convertTools([])).toEqual([]);
  });

  it("converts multiple tools", () => {
    const tools: MCPTool[] = [
      makeMcpTool({ name: "tool_a" }),
      makeMcpTool({ name: "tool_b" }),
      makeMcpTool({ name: "tool_c" }),
    ];

    const result = convertTools(tools);

    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(["tool_a", "tool_b", "tool_c"]);
  });
});

// ── Schema title preservation ─────────────────────────────────────

describe("convertTool — schema-level description/title", () => {
  it("preserves schema-level description", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: {},
        description: "Top-level input schema",
      },
    });

    const result = convertTool(tool);

    expect(result.inputSchema.description).toBe("Top-level input schema");
  });

  it("preserves schema-level title", () => {
    const tool = makeMcpTool({
      inputSchema: {
        type: "object" as const,
        properties: {},
        title: "CreateTaskInput",
      },
    });

    const result = convertTool(tool);

    expect(result.inputSchema.title).toBe("CreateTaskInput");
  });
});
