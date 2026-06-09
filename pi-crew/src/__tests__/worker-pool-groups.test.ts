import { describe, expect, it } from "vitest";

import { CrewConfigSchema } from "../config.js";
import {
  buildGroupOwnedPoolMemberSelector,
  resolveWorkerPoolMembers,
} from "../worker-pool-groups.js";

function groupedConfigInput(): unknown {
  return {
    install: { root: "/home/agents/pi-crew" },
    den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
    workerPool: {
      groups: [
        {
          groupId: "pi-crew-coder",
          role: "coder",
          profileIdentity: "pi-crew-coder-worker",
          profileId: "coder-worker",
          desiredSize: 4,
          identityTemplate: "pi-crew-coder-{n}",
          capabilities: ["typescript", "den", "git"],
          labels: { pool_group: "pi-crew-coder", owner: "pi-crew" },
        },
        {
          groupId: "pi-crew-reviewer",
          role: "reviewer",
          profileIdentity: "pi-crew-reviewer-worker",
          profileId: "reviewer-worker",
          desiredSize: 2,
          identityTemplate: "pi-crew-reviewer-{n}",
          capabilities: ["review", "den", "git"],
          labels: { pool_group: "pi-crew-reviewer", owner: "pi-crew" },
        },
      ],
    },
  };
}

describe("worker pool logical groups", () => {
  it("parses desired-size workerPool.groups from crew config", () => {
    const config = CrewConfigSchema.parse(groupedConfigInput());

    expect(config.workerPool.groups).toEqual([
      {
        groupId: "pi-crew-coder",
        role: "coder",
        profileIdentity: "pi-crew-coder-worker",
        profileId: "coder-worker",
        desiredSize: 4,
        identityTemplate: "pi-crew-coder-{n}",
        capabilities: ["typescript", "den", "git"],
        labels: { pool_group: "pi-crew-coder", owner: "pi-crew" },
      },
      {
        groupId: "pi-crew-reviewer",
        role: "reviewer",
        profileIdentity: "pi-crew-reviewer-worker",
        profileId: "reviewer-worker",
        desiredSize: 2,
        identityTemplate: "pi-crew-reviewer-{n}",
        capabilities: ["review", "den", "git"],
        labels: { pool_group: "pi-crew-reviewer", owner: "pi-crew" },
      },
    ]);
  });

  it("deterministically expands groups into concrete members with selector-safe metadata", () => {
    const config = CrewConfigSchema.parse(groupedConfigInput());

    const members = resolveWorkerPoolMembers(config);

    expect(members.map((member) => member.workerIdentity)).toEqual([
      "pi-crew-coder-1",
      "pi-crew-coder-2",
      "pi-crew-coder-3",
      "pi-crew-coder-4",
      "pi-crew-reviewer-1",
      "pi-crew-reviewer-2",
    ]);
    expect(members[0]).toEqual({
      workerIdentity: "pi-crew-coder-1",
      profileIdentity: "pi-crew-coder-worker",
      role: "coder",
      displayName: "pi-crew-coder lane 1",
      capabilities: ["typescript", "den", "git"],
      profileId: "coder-worker",
      metadata: {
        install_root: "/home/agents/pi-crew",
        profile_id: "coder-worker",
        execution_mode: "llmAgent",
        pool_group: "pi-crew-coder",
        group_id: "pi-crew-coder",
        desired_size: 4,
        lane_index: 1,
        identity_template: "pi-crew-coder-{n}",
        owner: "pi-crew",
        labels: { pool_group: "pi-crew-coder", owner: "pi-crew" },
      },
    });
  });

  it("keeps flat members as the backward-compatible migration path when groups are absent", () => {
    const config = CrewConfigSchema.parse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      workerPool: {
        members: [
          {
            workerIdentity: "pi-crew-coder-1",
            profileIdentity: "pi-crew-coder-worker",
            role: "coder",
            capabilities: ["typescript", "den"],
          },
        ],
      },
    });

    expect(resolveWorkerPoolMembers(config)).toEqual(config.workerPool.members);
  });

  it("selects cleanup candidates by group metadata and owner rather than name glob", () => {
    const selector = buildGroupOwnedPoolMemberSelector({ groupId: "pi-crew-coder", owner: "pi-crew" });

    expect(
      selector({
        workerIdentity: "pi-crew-coder-1",
        metadata: JSON.stringify({ pool_group: "pi-crew-coder", owner: "pi-crew" }),
      }),
    ).toBe(true);
    expect(
      selector({
        workerIdentity: "pi-crew-coder-manual-lookalike",
        metadata: JSON.stringify({ pool_group: "other", owner: "pi-crew" }),
      }),
    ).toBe(false);
    expect(selector({ workerIdentity: "pi-crew-coder-2", metadata: undefined })).toBe(false);
  });
});
