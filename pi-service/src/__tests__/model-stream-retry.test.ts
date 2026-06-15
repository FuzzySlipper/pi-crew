import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import type { GatewayEvent } from "@pi-crew/core";
import {
  DEFAULT_STREAM_RETRY_CONFIG,
  classifyStreamError,
  retryDelayMs,
  withRetryingStream,
} from "../model-stream-retry.js";

const model: Model<Api> = {
  id: "test-model",
  name: "test-model",
  provider: "den-router",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 100,
};
const context: Context = { messages: [] };

describe("withRetryingStream", () => {
  it("retries a 429 and honors Retry-After", async () => {
    let calls = 0;
    const delays: number[] = [];
    const events: GatewayEvent[] = [];
    const wrapped = withRetryingStream(stream(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate limit"), { status: 429, headers: { "retry-after": "2" } });
      return successStream("ok");
    }), retryOptions(events, delays));

    const seen = await collect(wrapped(model, context));

    expect(calls).toBe(2);
    expect(delays).toEqual([2000]);
    expect(seen.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
    expect(events[0]).toMatchObject({ event: "model.stream.retry_scheduled", payload: { statusCode: 429, delayMs: 2000, attempt: 1 } });
  });

  it("uses jittered exponential backoff for transient backend/network failures", () => {
    const classification = classifyStreamError(Object.assign(new Error("backend unavailable"), { status: 503 }));
    expect(classification).toMatchObject({ retryable: true, reason: "http_503" });
    expect(retryDelayMs(2, { ...DEFAULT_STREAM_RETRY_CONFIG, baseDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.5 }, classification, () => 1)).toBe(300);
    expect(classifyStreamError(Object.assign(new Error("socket"), { code: "ECONNRESET" }))).toMatchObject({ retryable: true, reason: "ECONNRESET" });
  });

  it("does not retry permanent auth, invalid request, or context errors", async () => {
    let calls = 0;
    const events: GatewayEvent[] = [];
    const wrapped = withRetryingStream(stream(() => {
      calls += 1;
      throw Object.assign(new Error("invalid api key"), { status: 401 });
    }), retryOptions(events, []));

    const seen = await collect(wrapped(model, context));

    expect(calls).toBe(1);
    expect(seen.at(-1)?.type).toBe("error");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "model.stream.retry_exhausted", payload: { retryable: false, reason: "http_401" } });
    expect(classifyStreamError(new Error("maximum context length exceeded"))).toMatchObject({ retryable: false, reason: "context_overflow" });
    expect(classifyStreamError(new Error("tool execution failed"))).toMatchObject({ retryable: false, reason: "invalid_request" });
  });

  it("stops after max attempts", async () => {
    let calls = 0;
    const events: GatewayEvent[] = [];
    const wrapped = withRetryingStream(stream(() => {
      calls += 1;
      throw Object.assign(new Error("bad gateway"), { status: 502 });
    }), retryOptions(events, []));

    await collect(wrapped(model, context));

    expect(calls).toBe(3);
    expect(events.map((event) => event.event)).toEqual([
      "model.stream.retry_scheduled",
      "model.stream.retry_scheduled",
      "model.stream.retry_exhausted",
    ]);
  });

  it("does not replay after partial output has been emitted", async () => {
    let calls = 0;
    const events: GatewayEvent[] = [];
    const wrapped = withRetryingStream(stream(() => {
      calls += 1;
      return throwingPartialStream();
    }), retryOptions(events, []));

    const seen = await collect(wrapped(model, context));

    expect(calls).toBe(1);
    expect(seen.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(events[0]).toMatchObject({ event: "model.stream.partial_failure", payload: { attempt: 1 } });
  });

  it("returns the original stream function when disabled", () => {
    const original = stream(() => successStream("ok"));
    const wrapped = withRetryingStream(original, { ...retryOptions([], []), config: { ...DEFAULT_STREAM_RETRY_CONFIG, enabled: false } });
    expect(wrapped).toBe(original);
  });
});

function retryOptions(events: GatewayEvent[], delays: number[]) {
  return {
    config: { ...DEFAULT_STREAM_RETRY_CONFIG, baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0 },
    eventBus: { emit: (event: GatewayEvent) => { events.push(event); } },
    correlation: { sessionId: "sess-1", profileId: "profile-1" },
    sleep: (delayMs: number) => { delays.push(delayMs); return Promise.resolve(); },
    random: () => 0.5,
  };
}

function stream(fn: StreamFunction<Api, SimpleStreamOptions>): StreamFunction<Api, SimpleStreamOptions> {
  return fn;
}

function successStream(text: string): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const message = assistant(text, "stop");
  queueMicrotask(() => {
    output.push({ type: "start", partial: assistant("", "stop") });
    output.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    output.push({ type: "done", reason: "stop", message });
    output.end(message);
  });
  return output;
}

function throwingPartialStream(): AssistantMessageEventStream {
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: assistant("", "stop") },
    { type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant("hel", "stop") },
  ];
  const iterable = {
    *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      yield events[0] as AssistantMessageEvent;
      yield events[1] as AssistantMessageEvent;
      throw Object.assign(new Error("upstream dropped"), { status: 503 });
    },
    result: () => Promise.reject(new Error("upstream dropped")),
  };
  return iterable as unknown as AssistantMessageEventStream;
}

async function collect(source: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: text.length === 0 ? [] : [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}
