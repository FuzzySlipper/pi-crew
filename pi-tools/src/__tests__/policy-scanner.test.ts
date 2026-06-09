/** Tests for pure ExecutionPolicy scanner helpers. */

import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "@pi-crew/core";
import { createExecutionPolicy } from "../execution-policy.js";
import {
  scanCredentials,
  scanHosts,
  scanPaths,
  scanToolName,
} from "../policy-scanner.js";

function policy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    ...createExecutionPolicy({
      policyId: "policy-scanner-test",
      rootPath: "/workspace/task",
      credentialScope: "none",
    }),
    ...overrides,
  };
}

describe("scanPaths", () => {
  it("allows relative paths resolved under an allowed rootPath subpath", () => {
    const result = scanPaths(
      policy({ allowedPaths: ["/workspace/task/src"] }),
      { path: "src/index.ts" },
    );

    expect(result).toEqual({ allowed: true, reason: "" });
  });

  it("denies traversal that escapes allowed paths", () => {
    const result = scanPaths(
      policy({ allowedPaths: ["/workspace/task/src"] }),
      { path: "../secrets/key.txt" },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("execution policy");
    expect(result.reason).toContain("allowed paths");
  });

  it("does not allow sibling prefixes that only start with an allowed path string", () => {
    const result = scanPaths(
      policy({ allowedPaths: ["/workspace/task/src"] }),
      { path: "/workspace/task/src-not-allowed/file.ts" },
    );

    expect(result.allowed).toBe(false);
  });

  it("honors explicit deny paths before allow paths", () => {
    const result = scanPaths(
      policy({
        allowedPaths: ["/workspace/task"],
        denyPaths: ["/workspace/task/private"],
      }),
      { path: "private/secret.txt" },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("/workspace/task/private");
  });
});

describe("scanHosts", () => {
  it("allows URL calls to explicitly allowed hosts despite case, port, and credentials", () => {
    const result = scanHosts(
      policy({ allowedHosts: ["api.example.com"] }),
      { url: "https://user:pass@API.EXAMPLE.com:8443/v1" },
    );

    expect(result).toEqual({ allowed: true, reason: "" });
  });

  it("denies hosts in deniedHosts", () => {
    const result = scanHosts(
      policy({ deniedHosts: ["metadata.google.internal"] }),
      { url: "http://metadata.google.internal/computeMetadata/v1" },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("execution policy");
    expect(result.reason).toContain("metadata.google.internal");
  });

  it("denies hosts outside a non-empty allowlist", () => {
    const result = scanHosts(
      policy({ allowedHosts: ["den-srv", "192.168.1.10"] }),
      { url: "https://example.com/resource" },
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("allowed hosts");
  });

  it("normalizes localhost aliases", () => {
    const result = scanHosts(
      policy({ deniedHosts: ["localhost"] }),
      { url: "http://[::1]:9236/health" },
    );

    expect(result.allowed).toBe(false);
  });
});

describe("scanCredentials", () => {
  it("allows no-credential calls when credentialScope is none", () => {
    const result = scanCredentials(policy({ credentialScope: "none" }), { prompt: "status" });

    expect(result).toEqual({ allowed: true, reason: "" });
  });

  it("denies read-only credential access when credentialScope is none", () => {
    const result = scanCredentials(policy({ credentialScope: "none" }), {
      credentialAccess: "read_only",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("read_only");
    expect(result.reason).toContain("execution policy");
  });

  it("allows read-only credential access but denies write access under read_only scope", () => {
    expect(scanCredentials(policy({ credentialScope: "read_only" }), {
      credentialAccess: "read_only",
    })).toEqual({ allowed: true, reason: "" });

    expect(scanCredentials(policy({ credentialScope: "read_only" }), {
      credentialAccess: "bounded_write",
    }).allowed).toBe(false);
  });

  it("infers bounded-write credential access from mutating operations", () => {
    const result = scanCredentials(policy({ credentialScope: "read_only" }), {
      operation: "patch",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("bounded_write");
  });

  it("fails closed for missing or unknown credential policy scope", () => {
    const invalidPolicy = {
      ...policy(),
      credentialScope: "mystery",
    } as unknown as ExecutionPolicy;

    const result = scanCredentials(invalidPolicy, { prompt: "status" });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("unknown credential scope");
  });
});

describe("scanToolName", () => {
  it("allows tools when no allowlist or denylist is configured", () => {
    expect(scanToolName(policy(), "read_file")).toEqual({ allowed: true, reason: "" });
  });

  it("denies explicitly denied tools before allowlist checks", () => {
    const result = scanToolName(
      policy({ allowedTools: ["terminal"], deniedTools: ["terminal"] }),
      "terminal",
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("execution policy");
    expect(result.reason).toContain("explicitly denied");
  });

  it("denies tools outside a non-empty allowlist", () => {
    const result = scanToolName(policy({ allowedTools: ["read_file"] }), "terminal");

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("allowlist");
  });
});
