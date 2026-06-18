import { isIP } from "node:net";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebExtractResult {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly error?: string;
}

export interface WebSearchProvider {
  search(query: string, maxResults: number): Promise<readonly WebSearchResult[]>;
}

export interface WebToolOptions {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxExtractChars?: number;
  readonly searchDefaultLimit?: number;
  readonly maxRedirects?: number;
  readonly searxngUrl?: string;
  readonly allowPrivateNet?: boolean;
}

export function createWebTools(options: WebToolOptions = {}): AgentTool[] {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const maxExtractChars = options.maxExtractChars ?? 24_000;
  const searchDefaultLimit = options.searchDefaultLimit ?? 5;
  const maxRedirects = options.maxRedirects ?? 5;
  const searxngUrl =
    options.searxngUrl !== undefined && options.searxngUrl.trim().length > 0
      ? options.searxngUrl
      : env.PI_CREW_SEARXNG_URL;
  const allowPrivateNet =
    options.allowPrivateNet ?? env.PI_CREW_ALLOW_PRIVATE_NET === "1";
  const provider = createWebSearchProvider({ fetchImpl, searxngUrl });
  return [webSearchTool(provider, searchDefaultLimit), webExtractTool(fetchImpl, maxExtractChars, maxRedirects, allowPrivateNet)];
}

export function createWebSearchProvider(input: {
  readonly fetchImpl: typeof fetch;
  readonly searxngUrl: string | undefined;
}): WebSearchProvider {
  if (input.searxngUrl !== undefined && input.searxngUrl.trim().length > 0) {
    return new SearxngProvider(input.fetchImpl, input.searxngUrl);
  }
  return new DuckDuckGoHtmlProvider(input.fetchImpl);
}

class DuckDuckGoHtmlProvider implements WebSearchProvider {
  constructor(private readonly fetchImpl: typeof fetch) {}

  async search(query: string, maxResults: number): Promise<readonly WebSearchResult[]> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await this.fetchImpl(url, { headers: { "user-agent": "pi-crew-web-tool/1" } });
    if (!response.ok) throw new Error(`DuckDuckGo search failed with HTTP ${String(response.status)}`);
    return parseDuckDuckGoResults(await response.text()).slice(0, maxResults);
  }
}

class SearxngProvider implements WebSearchProvider {
  constructor(private readonly fetchImpl: typeof fetch, private readonly baseUrl: string) {}

  async search(query: string, maxResults: number): Promise<readonly WebSearchResult[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`SearXNG search failed with HTTP ${String(response.status)}`);
    const data = await response.json() as { readonly results?: readonly SearxngResult[] };
    return (data.results ?? []).slice(0, maxResults).map((entry) => ({
      title: entry.title ?? entry.url ?? "untitled",
      url: entry.url ?? "",
      snippet: entry.content ?? "",
    })).filter((entry) => entry.url.length > 0);
  }
}

interface SearxngResult {
  readonly title?: string;
  readonly url?: string;
  readonly content?: string;
}

function webSearchTool(provider: WebSearchProvider, searchDefaultLimit: number): AgentTool {
  return {
    label: "Web search",
    name: "web_search",
    description: "Search the public web through the configured provider. Prefer for current facts and external docs. Returns title/url/snippet results; use web_extract for page text.",
    parameters: objectSchema({
      query: { type: "string", description: "Search query." },
      max_results: { type: "integer", default: searchDefaultLimit, minimum: 1, maximum: 10 },
    }, ["query"]),
    execute: async (_toolCallId, params) => {
      const results = await provider.search(stringParam(params, "query"), intParam(params, "max_results", searchDefaultLimit));
      return textResult(JSON.stringify({ results }, null, 2), { ok: true, results });
    },
  };
}

function webExtractTool(
  fetchImpl: typeof fetch,
  maxExtractChars: number,
  maxRedirects: number,
  allowPrivateNet: boolean,
): AgentTool {
  return {
    label: "Web extract",
    name: "web_extract",
    description: "Fetch one or more public web pages and return bounded markdown-ish text. Blocks localhost/private-network URLs unless PI_CREW_ALLOW_PRIVATE_NET=1.",
    parameters: objectSchema({
      urls: {
        type: "array",
        description: "HTTP(S) URLs to fetch, max 5.",
        items: { type: "string" },
        maxItems: 5,
      },
    }, ["urls"]),
    execute: async (_toolCallId, params) => {
      const results = await Promise.all(urlArrayParam(params, "urls").slice(0, 5).map((url) => extractUrl(fetchImpl, url, maxExtractChars, maxRedirects, allowPrivateNet)));
      return textResult(JSON.stringify({ results }, null, 2), { ok: true, results });
    },
  };
}

async function extractUrl(
  fetchImpl: typeof fetch,
  rawUrl: string,
  maxExtractChars: number,
  maxRedirects: number,
  allowPrivateNet: boolean,
): Promise<WebExtractResult> {
  try {
    const response = await fetchPublicUrl(fetchImpl, rawUrl, allowPrivateNet, maxRedirects);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const text = await response.text();
    const title = htmlTitle(text) ?? rawUrl;
    const content = htmlToText(text).slice(0, maxExtractChars);
    return { url: rawUrl, title, content };
  } catch (error) {
    return { url: rawUrl, title: rawUrl, content: "", error: errorMessage(error) };
  }
}

export function assertSafePublicUrl(rawUrl: string, allowPrivateNet = false): void {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http/https URLs are allowed");
  if (allowPrivateNet) return;
  const host = normalizedHost(url);
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("localhost URLs are blocked");
  const ipKind = isIP(host);
  if (ipKind !== 0 && isPrivateIp(host, ipKind)) throw new Error("private-network URLs are blocked");
}

async function fetchPublicUrl(
  fetchImpl: typeof fetch,
  rawUrl: string,
  allowPrivateNet: boolean,
  maxRedirects: number,
): Promise<Response> {
  let current = rawUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    assertSafePublicUrl(current, allowPrivateNet);
    const response = await fetchImpl(current, {
      headers: { "user-agent": "pi-crew-web-tool/1" },
      redirect: "manual",
    });
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    current = new URL(location, current).toString();
  }
  throw new Error("Too many redirects");
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isPrivateIp(host: string, ipKind: 4 | 6): boolean {
  if (ipKind === 6) return isPrivateIpv6(host);
  if (host === "0.0.0.0" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return true;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length === 4 && parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
    || mappedIpv4IsPrivate(normalized);
}

function mappedIpv4IsPrivate(host: string): boolean {
  if (!host.startsWith("::ffff:")) return false;
  const suffix = host.slice("::ffff:".length);
  if (suffix.includes(".")) return isPrivateIp(suffix, 4);
  const parts = suffix.split(":");
  const high = Number.parseInt(parts.at(-2) ?? "", 16);
  const low = Number.parseInt(parts.at(-1) ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return false;
  const ipv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  return isPrivateIp(ipv4, 4);
}

function parseDuckDuckGoResults(html: string): readonly WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<a[^>]+class="result__a"/g).slice(1);
  for (const block of blocks) {
    const href = /href="([^"]+)"/.exec(block)?.[1];
    const titleHtml = />(.*?)<\/a>/s.exec(block)?.[1] ?? "";
    const snippetHtml = /class="result__snippet"[^>]*>(.*?)<\/a>/s.exec(block)?.[1]
      ?? /class="result__snippet"[^>]*>(.*?)<\/div>/s.exec(block)?.[1]
      ?? "";
    if (href === undefined) continue;
    results.push({ title: decodeHtml(stripTags(titleHtml)), url: normalizeDuckDuckGoUrl(decodeHtml(href)), snippet: decodeHtml(stripTags(snippetHtml)) });
  }
  return results;
}

function normalizeDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? url.toString();
  } catch {
    return value;
  }
}

function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>(.*?)<\/title>/is.exec(html);
  return match === null ? null : decodeHtml(stripTags(match[1] ?? "")).trim();
}

function htmlToText(html: string): string {
  return decodeHtml(stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "");
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function urlArrayParam(params: unknown, name: string): readonly string[] {
  const value = objectParam(params)[name];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new TypeError(`${name} entries must be strings`);
    return entry;
  });
}

function stringParam(params: unknown, name: string): string {
  const value = objectParam(params)[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a string`);
  return value;
}

function intParam(params: unknown, name: string, fallback: number): number {
  const value = objectParam(params)[name];
  return typeof value === "number" && Number.isInteger(value) ? Math.max(1, Math.min(10, value)) : fallback;
}

function objectParam(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
