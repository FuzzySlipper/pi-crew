/**
 * Converts MCP tool schemas (JSON Schema) to pi-mcp {@link AgentTool} format.
 *
 * Handles object/string/number/boolean/array types, required/optional params,
 * descriptions, and unknown schema fields without using `any`.
 *
 * @module pi-mcp/tool-converter
 */

import type { MCPTool, AgentTool, ToolAnnotations } from "./types.js";

// ── Public API ────────────────────────────────────────────────────

/**
 * Convert a single MCP tool definition to an {@link AgentTool}.
 *
 * Unknown fields on the `inputSchema` are preserved as `additionalProperties`
 * or custom extension markers, so downstream consumers can inspect them
 * without losing fidelity.
 */
export function convertTool(tool: MCPTool): AgentTool {
  const description = tool.description ?? `MCP tool: ${tool.name}`;

  return {
    name: tool.name,
    description,
    inputSchema: normalizeInputSchema(tool.inputSchema),
    annotations: convertAnnotations(tool.annotations),
  };
}

/**
 * Convert an array of MCP tools to AgentTool[].
 */
export function convertTools(tools: readonly MCPTool[]): AgentTool[] {
  return tools.map(convertTool);
}

// ── Schema normalisation ──────────────────────────────────────────

/**
 * Normalise an MCP input schema into a canonical AgentTool format.
 *
 * Preserves all known and unknown keys so callers can safely destructure
 * or pass-through without data loss.
 */
function normalizeInputSchema(
  raw: MCPTool["inputSchema"],
): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  // Known JSON Schema fields
  const rawObj = raw as Record<string, unknown>;
  schema.type = rawObj.type ?? "object";

  if (rawObj.properties !== undefined && rawObj.properties !== null) {
    schema.properties = normalizeProperties(
      rawObj.properties as Record<string, unknown>,
    );
  }

  if (Array.isArray(rawObj.required)) {
    schema.required = rawObj.required;
  }

  if (typeof rawObj.description === "string") {
    schema.description = rawObj.description;
  }

  if (typeof rawObj.title === "string") {
    schema.title = rawObj.title;
  }

  // Preserve any unknown / extension fields
  for (const [key, value] of Object.entries(rawObj)) {
    if (!KNOWN_SCHEMA_KEYS.has(key)) {
      schema[key] = value;
    }
  }

  return schema;
}

/** Keys handled explicitly — everything else is treated as an extension. */
const KNOWN_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "description",
  "title",
]);

/**
 * Normalise the `properties` map of an input schema.
 *
 * Each property descriptor is converted to a flat object with
 * standard JSON Schema fields.
 */
function normalizeProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [propName, propSchema] of Object.entries(properties)) {
    if (typeof propSchema === "object" && propSchema !== null) {
      result[propName] = normalizeProperty(
        propSchema as Record<string, unknown>,
      );
    } else {
      result[propName] = {};
    }
  }

  return result;
}

// ── Property-level helpers ────────────────────────────────────────

/** Standard JSON Schema property types we understand. */
type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object";

const VALID_JSON_TYPES = new Set<string>([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

/**
 * Normalise a single property descriptor to its canonical form.
 *
 * Unknown fields are preserved as-is; the function never throws.
 */
function normalizeProperty(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const prop: Record<string, unknown> = {};

  // type
  if (isValidJsonType(raw.type)) {
    prop.type = raw.type;
  } else {
    // Default to string when type is absent or unrecognized
    prop.type = "string";
  }

  // description
  if (typeof raw.description === "string") {
    prop.description = raw.description;
  }

  // default
  if ("default" in raw) {
    prop.default = raw.default;
  }

  // enum (array values)
  if (Array.isArray(raw.enum)) {
    prop.enum = raw.enum;
  }

  // items (only meaningful for array type)
  if (typeof raw.items === "object" && raw.items !== null) {
    prop.items = normalizeProperty(
      raw.items as Record<string, unknown>,
    );
  }

  // Preserve unknown extension fields
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_PROPERTY_KEYS.has(key)) {
      prop[key] = value;
    }
  }

  return prop;
}

/** Property descriptor keys handled explicitly. */
const KNOWN_PROPERTY_KEYS = new Set([
  "type",
  "description",
  "default",
  "enum",
  "items",
]);

// ── Helpers ───────────────────────────────────────────────────────

function isValidJsonType(value: unknown): value is JsonSchemaType {
  return typeof value === "string" && VALID_JSON_TYPES.has(value);
}

// ── Annotations ───────────────────────────────────────────────────

function convertAnnotations(annotations?: ToolAnnotations): ToolAnnotations | undefined {
  if (!annotations || Object.keys(annotations).length === 0) {
    return undefined;
  }

  const result: ToolAnnotations = {};

  if (typeof annotations.title === "string") {
    result.title = annotations.title;
  }
  if (typeof annotations.readOnlyHint === "boolean") {
    result.readOnlyHint = annotations.readOnlyHint;
  }
  if (typeof annotations.destructiveHint === "boolean") {
    result.destructiveHint = annotations.destructiveHint;
  }
  if (typeof annotations.idempotentHint === "boolean") {
    result.idempotentHint = annotations.idempotentHint;
  }
  if (typeof annotations.openWorldHint === "boolean") {
    result.openWorldHint = annotations.openWorldHint;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
