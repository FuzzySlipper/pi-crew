import { describe, expect, it } from "vitest";
import { FakeLogger } from "@pi-crew/core";
import {
  createCrewAssignmentLoops,
  type CrewAssignmentLoopSource,
} from "../crew-assignment-loops.js";
import type { DenAssignmentLoopRunner } from "../den-assignment-loop.js";
import type { DenPoolMemberConfig } from "../den-pool-source.js";

class FakeRunner implements DenAssignmentLoopRunner {
  runOnce(): Promise<{
    readonly status: "no_assignment";
    readonly reason: string;
    readonly diagnostic: string;
  }> {
    return Promise.resolve({
      status: "no_assignment",
      reason: "none_available",
      diagnostic: "empty",
    });
  }
}

class FakeCrew implements CrewAssignmentLoopSource {
  readonly createdFor: string[] = [];

  constructor(readonly members: DenPoolMemberConfig[]) {}

  createDenAssignmentRunner(member: DenPoolMemberConfig): DenAssignmentLoopRunner {
    this.createdFor.push(member.workerIdentity);
    return new FakeRunner();
  }
}

const members: DenPoolMemberConfig[] = [
  {
    workerIdentity: "pi-crew-coder-1",
    profileIdentity: "pi-crew-coder-worker",
    role: "coder",
    capabilities: ["typescript", "den"],
  },
  {
    workerIdentity: "pi-crew-reviewer-1",
    profileIdentity: "pi-crew-reviewer-worker",
    role: "reviewer",
    capabilities: ["review", "den"],
  },
];

describe("createCrewAssignmentLoops", () => {
  it("creates one assignment loop per configured worker pool member", () => {
    const crew = new FakeCrew(members);

    const loops = createCrewAssignmentLoops({
      crew,
      members: crew.members,
      logger: new FakeLogger(),
      pollIntervalMs: 100,
    });

    expect(loops.map((loop) => loop.workerIdentity)).toEqual([
      "pi-crew-coder-1",
      "pi-crew-reviewer-1",
    ]);
    expect(crew.createdFor).toEqual(["pi-crew-coder-1", "pi-crew-reviewer-1"]);
  });

  it("starts and stops all configured loops", async () => {
    const crew = new FakeCrew(members);
    const loops = createCrewAssignmentLoops({
      crew,
      members: crew.members,
      logger: new FakeLogger(),
      pollIntervalMs: 100,
    });

    loops.forEach((loop) => {
      loop.start();
    });
    expect(loops.every((loop) => loop.isRunning)).toBe(true);

    await Promise.all(loops.map((loop) => loop.stop("test")));

    expect(loops.every((loop) => !loop.isRunning)).toBe(true);
  });

  it("does not create loops when the worker pool is empty", () => {
    const crew = new FakeCrew([]);

    const loops = createCrewAssignmentLoops({
      crew,
      members: crew.members,
      logger: new FakeLogger(),
      pollIntervalMs: 100,
    });

    expect(loops).toEqual([]);
    expect(crew.createdFor).toEqual([]);
  });
});
