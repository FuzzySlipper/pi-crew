import { describe, expect, it } from "vitest";
import type { EffectiveDelegationRuntime } from "@pi-crew/core";
import { resolveEffectiveRuntime } from "../../workers/delegated-spawn-lifecycle-helpers.js";

const parentRuntime: EffectiveDelegationRuntime = {
  profileId: "parent-profile",
  provider: "den-router",
  model: "gpt",
};

describe("resolveEffectiveRuntime", () => {
  it("does not inherit parent provider/model when only a different child profile is requested", () => {
    const result = resolveEffectiveRuntime(parentRuntime, [], { profileId: "coder-worker" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ profileId: "coder-worker" });
  });

  it("inherits provider/model when no child profile switch is requested", () => {
    const result = resolveEffectiveRuntime(parentRuntime, [], undefined);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(parentRuntime);
  });
});
