import { describe, expect, it } from "vitest";
import { assertSafePublicUrl, createWebSearchProvider, createWebTools } from "../web-tools.js";
import { toolRequestedBySets } from "../tool-selection.js";

describe("web tools", () => {
  it("selects SearXNG provider from env and normalizes results", async () => {
    const provider = createWebSearchProvider({
      env: { PI_CREW_SEARXNG_URL: "https://search.example/search" },
      fetchImpl: fakeFetch(JSON.stringify({ results: [{ title: "Doc", url: "https://example.com", content: "Snippet" }] })),
    });

    await expect(provider.search("pi crew", 5)).resolves.toEqual([
      { title: "Doc", url: "https://example.com", snippet: "Snippet" },
    ]);
  });

  it("blocks private URLs by default and allows them only when opted in", () => {
    expect(() => {
      assertSafePublicUrl("http://localhost:9237/health");
    }).toThrow("localhost");
    expect(() => {
      assertSafePublicUrl("http://192.168.1.10/", false);
    }).toThrow("private-network");
    expect(() => {
      assertSafePublicUrl("http://[::1]/", false);
    }).toThrow("private-network");
    expect(() => {
      assertSafePublicUrl("http://[::ffff:7f00:1]/", false);
    }).toThrow("private-network");
    expect(() => {
      assertSafePublicUrl("http://[::ffff:a9fe:101]/", false);
    }).toThrow("private-network");
    expect(() => {
      assertSafePublicUrl("http://169.254.1.1/", false);
    }).toThrow("private-network");
    expect(() => {
      assertSafePublicUrl("http://192.168.1.10/", true);
    }).not.toThrow();
  });

  it("keeps category allow sets aligned with non-prefixed tool names", () => {
    expect(toolRequestedBySets("todo", ["planning"])).toBe(true);
    expect(toolRequestedBySets("read_file", ["filesystem"])).toBe(true);
    expect(toolRequestedBySets("web_search", ["web"])).toBe(true);
    expect(toolRequestedBySets("browser_snapshot", ["browser"])).toBe(true);
  });

  it("does not follow redirects to blocked private URLs", async () => {
    const tools = createWebTools({
      env: {},
      fetchImpl: redirectFetch("http://127.0.0.1/private"),
    });
    const extract = tools[1];
    if (extract === undefined) throw new Error("missing web_extract tool");
    const result = await extract.execute("call", { urls: ["https://example.com/page"] });
    const content = result.content[0] as { readonly text?: string } | undefined;
    expect(content?.text).toContain("private-network URLs are blocked");
  });

  it("extracts bounded text through web_extract", async () => {
    const tools = createWebTools({
      env: {},
      fetchImpl: fakeFetch("<html><title>Hello</title><body><p>Useful text</p></body></html>"),
    });
    const extract = tools[1];
    if (extract === undefined) throw new Error("missing web_extract tool");
    const result = await extract.execute("call", { urls: ["https://example.com/page"] });
    const content = result.content[0] as { readonly text?: string } | undefined;
    expect(content?.text).toContain("Useful text");
  });
});

function fakeFetch(body: string): typeof fetch {
  return () => Promise.resolve(new Response(body, { status: 200 }));
}

function redirectFetch(location: string): typeof fetch {
  return () => Promise.resolve(new Response("", { status: 302, headers: { location } }));
}
