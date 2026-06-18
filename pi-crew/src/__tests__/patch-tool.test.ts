/** Tests for the patch tool. */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPatchTool } from "../patch-tool.js";

function makeTool() {
  const rootPath = mkdtempSync(join(tmpdir(), "pi-patch-tool-"));
  const tool = createPatchTool({ rootPath });
  return { rootPath, tool };
}

/** Extract text from the first text content block. */
function resultText(result: { content: readonly unknown[]; details: Record<string, unknown> }): string {
  const block: unknown = result.content[0];
  if (typeof block === "object" && block !== null && "text" in block) {
    return String((block as Record<string, unknown>).text ?? "");
  }
  return "";
}

describe("patch tool — replace mode", () => {
  it("replaces a unique match", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "hello world", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "hello world",
      new_string: "hello patch",
    });

    expect(result.details).toMatchObject({ ok: true, path: "test.txt", replacements: 1 });
    expect(readFileSync(join(rootPath, "test.txt"), "utf8")).toBe("hello patch");
    const text = resultText(result);
    expect(text).toContain("--- test.txt");
    expect(text).toContain("-hello world");
    expect(text).toContain("+hello patch");
  });

  it("rejects non-unique match without replace_all", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "foo bar foo baz", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "foo",
      new_string: "qux",
    });

    expect(result.details).toMatchObject({ ok: false });
    expect(resultText(result)).toContain("matched 2 times");
  });

  it("replaces all occurrences with replace_all=true", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "foo bar foo baz", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "foo",
      new_string: "qux",
      replace_all: true,
    });

    expect(result.details).toMatchObject({ ok: true, replacements: 2 });
    expect(readFileSync(join(rootPath, "test.txt"), "utf8")).toBe("qux bar qux baz");
  });

  it("deletes text with empty new_string", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "hello [remove] world", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "[remove]",
      new_string: "",
    });

    expect(result.details).toMatchObject({ ok: true });
    expect(readFileSync(join(rootPath, "test.txt"), "utf8")).toBe("hello  world");
  });

  it("handles multi-line replacements", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "line1\nline2\nline3\n", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "line2\nline3",
      new_string: "replaced2\nreplaced3",
    });

    expect(result.details).toMatchObject({ ok: true });
    expect(readFileSync(join(rootPath, "test.txt"), "utf8")).toBe("line1\nreplaced2\nreplaced3\n");
  });

  it("blocks path escape attempts", async () => {
    const { rootPath, tool } = makeTool();

    const result = await tool.execute("call-1", {
      path: "../etc/passwd",
      old_string: "foo",
      new_string: "bar",
    });

    expect(result.details).toMatchObject({ ok: false });
  });

  it("reports readable error for missing file", async () => {
    const { rootPath: _rp, tool } = makeTool();

    const result = await tool.execute("call-1", {
      path: "nonexistent.txt",
      old_string: "anything",
      new_string: "nothing",
    });

    expect(result.details).toMatchObject({ ok: false });
    expect(resultText(result)).toContain("Cannot read file");
  });
});

describe("patch tool — fuzzy matching", () => {
  it("handles trailing space drift", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "hello   \nworld\n", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "hello\nworld",
      new_string: "hi\nuniverse",
    });

    expect(result.details).toMatchObject({ ok: true });
    expect(readFileSync(join(rootPath, "test.txt"), "utf8")).toBe("hi\nuniverse\n");
  });

  it("handles whitespace differences", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "  indent 1\n    indent 2\n", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "indent 1\nindent 2",
      new_string: "replaced 1\nreplaced 2",
    });

    expect(result.details).toMatchObject({ ok: true });
    expect(readFileSync(join(rootPath, "test.txt"), "utf8")).toBe("replaced 1\nreplaced 2\n");
  });

  it("handles full content replacement", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "test.txt"), "a   b   c", "utf8");

    const result = await tool.execute("call-1", {
      path: "test.txt",
      old_string: "a   b   c",
      new_string: "xyz",
    });

    expect(result.details).toMatchObject({ ok: true });
    expect(readFileSync(join(rootPath, "test.txt"), "utf8")).toBe("xyz");
  });
});

describe("patch tool — patch mode", () => {
  it("applies a V4A multi-file patch", async () => {
    const { rootPath, tool } = makeTool();
    writeFileSync(join(rootPath, "a.txt"), "line1\nold_line\nline3\n", "utf8");
    writeFileSync(join(rootPath, "b.txt"), "keep\nremove_me\nalso_keep\n", "utf8");

    const result = await tool.execute("call-1", {
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@ a-block @@",
        "old_line",
        "-old_line",
        "+new_line",
        "*** Update File: b.txt",
        "@@ b-block @@",
        "remove_me",
        "-remove_me",
        "+replaced",
      ].join("\n"),
    });

    expect(result.details).toMatchObject({ ok: true, filesApplied: 2, errors: 0 });
    expect(readFileSync(join(rootPath, "a.txt"), "utf8")).toBe("line1\nnew_line\nline3\n");
    expect(readFileSync(join(rootPath, "b.txt"), "utf8")).toBe("keep\nreplaced\nalso_keep\n");
  });
});

describe("patch tool — cross_profile guard", () => {
  it("blocks profiles path without cross_profile flag", async () => {
    const { rootPath, tool } = makeTool();
    // Simulate a path that looks like it's in a Hermes profile
    const hermesPath = join(rootPath, "hermes", "skills", "test.txt");
    mkdirSync(join(rootPath, "hermes", "skills"), { recursive: true });
    writeFileSync(hermesPath, "content", "utf8");

    const result = await tool.execute("call-1", {
      path: "hermes/skills/test.txt",
      old_string: "content",
      new_string: "modified",
    });

    expect(result.details).toMatchObject({ ok: false });
    expect(resultText(result)).toContain("cross_profile");
  });
});

describe("patch tool — syntax check rollback", () => {
  it("rolls back on TypeScript syntax error", async () => {
    const { rootPath, tool } = makeTool();
    const filePath = join(rootPath, "valid.ts");
    writeFileSync(filePath, "const x: number = 1;\n", "utf8");

    const result = await tool.execute("call-1", {
      path: "valid.ts",
      old_string: "const x: number = 1;",
      new_string: "const x: number = 'string';",
    });

    expect(result.details).toMatchObject({ ok: false });
    expect(resultText(result)).toContain("rolled back");
    expect(readFileSync(filePath, "utf8")).toBe("const x: number = 1;\n");
  });
});
