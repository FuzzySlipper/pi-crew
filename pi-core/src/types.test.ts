import { describe, it, expect } from "vitest";
import {
  type Result,
  ok,
  err,
} from "./types.js";

describe("Result type", () => {
  it("ok() wraps a value in a success Result", () => {
    const result: Result<number> = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("err() wraps an error in a failure Result", () => {
    const result: Result<number> = err(new Error("boom"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("boom");
    }
  });

  it("narrows correctly via ok discriminant", () => {
    const maybe = Math.random() > 0.5 ? ok("yes") : err(new Error("no"));
    // Both branches must compile without type errors
    if (maybe.ok) {
      const _val: string = maybe.value;
      expect(_val.length).toBeGreaterThan(0);
    } else {
      const _err: Error = maybe.error;
      expect(_err).toBeInstanceOf(Error);
    }
  });

  it("supports custom error types", () => {
    type MyErr = { code: number; detail: string };
    const result: Result<string, MyErr> = err({ code: 404, detail: "not found" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(404);
    }
  });
});
