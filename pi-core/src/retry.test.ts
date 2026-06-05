import { describe, it, expect, vi } from "vitest";
import { retryWithBackoff, type RetryPolicy, DEFAULT_RETRY_POLICY } from "./retry.js";

describe("retryWithBackoff", () => {
  const fastPolicy: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 5,
  };

  it("returns the result on first success", async () => {
    const fn = vi.fn(() => Promise.resolve("ok"));
    const result = await retryWithBackoff(fn, fastPolicy);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and returns success", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");

    const result = await retryWithBackoff(fn, fastPolicy);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting attempts", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("always fail")));

    await expect(retryWithBackoff(fn, fastPolicy)).rejects.toThrow(
      "always fail",
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff delays", async () => {
    const policy: RetryPolicy = {
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 50,
    };

    let callCount = 0;
    const fn = () => {
      callCount++;
      if (callCount < 4) return Promise.reject(new Error("fail"));
      return Promise.resolve("ok");
    };

    const start = Date.now();
    await retryWithBackoff(fn, policy);
    const elapsed = Date.now() - start;

    // Delays: 10ms (attempt 1→2), 20ms (2→3), 40ms (3→4)
    // Total >= 70ms (with some slop)
    expect(elapsed).toBeGreaterThanOrEqual(60);
  });

  it("caps delay at maxDelayMs", async () => {
    const policy: RetryPolicy = {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 150,
    };

    let callCount = 0;
    const fn = () => {
      callCount++;
      if (callCount < 5) return Promise.reject(new Error("fail"));
      return Promise.resolve("ok");
    };

    const start = Date.now();
    await retryWithBackoff(fn, policy);
    const elapsed = Date.now() - start;

    // Delays: 100, 150 (capped from 200), 150 (capped from 400), 150 (capped from 800)
    // Total >= 550ms
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });
});

describe("DEFAULT_RETRY_POLICY", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(5);
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(200);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(30_000);
  });
});
