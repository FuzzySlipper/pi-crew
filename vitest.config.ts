import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      "pi-core",
      "pi-profiles",
      "pi-memory",
      "pi-mcp",
      "pi-service",
      "pi-channels",
      "pi-tools",
      "pi-governance",
      "pi-crew",
    ],
  },
});
