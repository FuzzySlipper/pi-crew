/** Tests for local delegated code tools. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLocalCodeTools } from "../local-code-tools.js";

function getTool(name: string) {
  const rootPath = mkdtempSync(join(tmpdir(), "pi-local-code-tools-"));
  const tool = createLocalCodeTools({ rootPath }).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return { rootPath, tool };
}

describe("createLocalCodeTools", () => {
  it("reads files under the delegated root", async () => {
    const { rootPath, tool } = getTool("read_file");
    writeFileSync(join(rootPath, "README.md"), "hello delegated tools", "utf8");

    const result = await tool.execute("call-1", { path: "README.md" });

    expect(result.content).toEqual([{ type: "text", text: "hello delegated tools" }]);
  });

  it("runs terminal commands inside the delegated root", async () => {
    const { tool } = getTool("terminal");

    const result = await tool.execute("call-1", { command: "printf tool-ok" });

    expect(result.content).toEqual([{ type: "text", text: "tool-ok" }]);
  });
});
