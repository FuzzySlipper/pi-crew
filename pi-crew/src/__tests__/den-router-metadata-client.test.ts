import { describe, expect, it } from "vitest";
import {
  DenRouterMetadataClient,
  resolveFullAgentContextPolicy,
} from "../den-router-metadata-client.js";

class RecordingFetch {
  readonly urls: string[] = [];
  constructor(private readonly response: Response) {}
  fetch = (input: string | URL | Request): Promise<Response> => {
    this.urls.push(String(input));
    return Promise.resolve(this.response);
  };
}

const crewContext = {
  defaultContextLength: 131072,
  compactionThresholdPercent: 75,
  minimumRecentMessages: 32,
};

describe("DenRouterMetadataClient", () => {
  it("reads context length metadata from the per-model endpoint", async () => {
    const recorder = new RecordingFetch(
      new Response(
        JSON.stringify({
          context_length: 200000,
          source: "router_config",
        }),
        { status: 200 },
      ),
    );
    const client = new DenRouterMetadataClient({
      baseUrl: "http://router.test/v1/",
      fetchFn: recorder.fetch,
    });

    await expect(client.modelMetadata("grok/fast path")).resolves.toEqual({
      contextLength: 200000,
      source: "den-router",
    });
    expect(recorder.urls).toEqual(["http://router.test/v1/models/grok%2Ffast%20path/metadata"]);
  });

  it("falls back to configured defaults when metadata is unavailable", async () => {
    const recorder = new RecordingFetch(new Response("not found", { status: 404 }));

    await expect(
      resolveFullAgentContextPolicy({
        crewContext,
        provider: "den-router",
        modelName: "grok",
        modelBaseUrl: "http://router.test/v1",
        fetchFn: recorder.fetch,
      }),
    ).resolves.toEqual({
      contextLength: 131072,
      contextLengthSource: "config-default",
      thresholdPercent: 75,
      minimumRecentMessages: 32,
    });
  });

  it("does not query non-den-router providers", async () => {
    const recorder = new RecordingFetch(new Response("{}", { status: 200 }));

    await expect(
      resolveFullAgentContextPolicy({
        crewContext,
        provider: "openrouter",
        modelName: "gpt",
        modelBaseUrl: "http://router.test/v1",
        fetchFn: recorder.fetch,
      }),
    ).resolves.toMatchObject({ contextLengthSource: "config-default" });
    expect(recorder.urls).toEqual([]);
  });
});
