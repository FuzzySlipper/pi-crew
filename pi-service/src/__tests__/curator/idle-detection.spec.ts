/** Tests for idle detection logic. */

import { describe, it, expect } from "vitest";
import { checkIdle } from "../../curator/idle-detection.js";

describe("checkIdle", () => {
  it("returns idle when no active assignments or sessions", () => {
    const result = checkIdle(0, 0, false);
    expect(result.idle).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns not idle when system is in drain mode", () => {
    const result = checkIdle(0, 0, true);
    expect(result.idle).toBe(false);
    expect(result.reason).toContain("drain");
  });

  it("returns not idle when active assignments exist", () => {
    const result = checkIdle(3, 0, false);
    expect(result.idle).toBe(false);
    expect(result.reason).toContain("assignments");
  });

  it("returns not idle when active sessions exist", () => {
    const result = checkIdle(0, 5, false);
    expect(result.idle).toBe(false);
    expect(result.reason).toContain("sessions");
  });

  it("prefers drain mode over assignments", () => {
    const result = checkIdle(10, 0, true);
    expect(result.idle).toBe(false);
    expect(result.reason).toContain("drain");
  });

  it("prefers drain mode over sessions", () => {
    const result = checkIdle(0, 10, true);
    expect(result.idle).toBe(false);
    expect(result.reason).toContain("drain");
  });

  it("reports assignment count in reason", () => {
    const result = checkIdle(7, 0, false);
    expect(result.reason).toContain("7");
  });

  it("reports session count in reason", () => {
    const result = checkIdle(0, 12, false);
    expect(result.reason).toContain("12");
  });
});
