// pi-crew — Composition root: wires everything together into a pre-configured gateway.
// Depends on: all pi-* packages

export { Gateway, type GatewayConfig } from "@pi-crew/service";
export { type Logger, type GatewayEvent, type EventBus, type ChannelProvider } from "@pi-crew/core";
export { type Profile, type Skill, loadProfile } from "@pi-crew/profiles";
export { MCPClient, type MCPClientConfig, type MCPTool } from "@pi-crew/mcp";
export { ChannelRegistry, startAll } from "@pi-crew/channels";
export { createToolRegistry, type ToolDefinition, type ToolRegistry } from "@pi-crew/tools";
export { GovernanceLayer, type Breadcrumb } from "@pi-crew/governance";
export { type MemoryStore, type MemoryEntry } from "@pi-crew/memory";
