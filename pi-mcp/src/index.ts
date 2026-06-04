// pi-mcp — MCP client for connecting to MCP servers (e.g. den-mcp).
// Depends on: pi-core

import type { Logger } from "@pi-crew/core";

export interface MCPClientConfig {
  serverName: string;
  transport: "stdio" | "http";
  endpoint?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export class MCPClient {
  constructor(
    private readonly config: MCPClientConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await Promise.resolve();
    this.logger.info("MCPClient starting", { serverName: this.config.serverName });
  }

  async discoverTools(): Promise<MCPTool[]> {
    await Promise.resolve();
    return [];
  }

  async stop(): Promise<void> {
    await Promise.resolve();
    this.logger.info("MCPClient stopping", { serverName: this.config.serverName });
  }
}
