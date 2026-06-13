/** Tests for delegated child model resolution precedence. */

import { describe, expect, it } from "vitest";
import type { EffectiveDelegationRuntime } from "@pi-crew/core";
import { resolveDelegatedChildModel } from "../../workers/llm-delegated-child-model-resolution.js";

const runtimeWithModel: EffectiveDelegationRuntime = {
  profileId: "coder-child",
  provider: "profile-provider",
  model: "profile-coder-model",
};

describe("resolveDelegatedChildModel", () => {
  it("prefers child runtime model over legacy global delegation model fallback", () => {
    const model = resolveDelegatedChildModel(runtimeWithModel, {
      baseUrl: "http://127.0.0.1:9999/v1",
      modelName: "global-delegation-model",
    });

    expect(model.id).toBe("profile-coder-model");
    expect(model.name).toBe("profile-coder-model");
    expect(model.provider).toBe("profile-provider");
  });

  it("uses legacy global model only when child runtime has no model", () => {
    const model = resolveDelegatedChildModel(
      { profileId: "legacy-child", provider: "legacy-provider" },
      {
        baseUrl: "http://127.0.0.1:9999/v1",
        modelName: "global-delegation-model",
      },
    );

    expect(model.id).toBe("global-delegation-model");
    expect(model.provider).toBe("legacy-provider");
  });
});
