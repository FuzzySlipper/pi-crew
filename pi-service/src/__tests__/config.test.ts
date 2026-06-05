/**
 * Tests for config.ts — GatewayConfig loading and zod validation.
 */

import { describe, it, expect } from "vitest";
import { ConfigurationError } from "@pi-crew/core";
import { loadConfig } from "../config.js";

// ── Helper: minimal valid config ────────────────────────────────

const minimalValid = {
  den: { coreUrl: "http://den-srv:3030" },
};

describe("loadConfig", () => {
  describe("valid input", () => {
    it("accepts minimal valid config and fills defaults", () => {
      const cfg = loadConfig(minimalValid);
      expect(cfg.den.coreUrl).toBe("http://den-srv:3030");
      expect(cfg.den.requiredAtStartup).toBe(true);
      expect(cfg.database.path).toBe("/var/lib/pi-crew/runtime.db");
      expect(cfg.database.wal).toBe(true);
      expect(cfg.health.port).toBe(9236);
      expect(cfg.health.host).toBe("127.0.0.1");
      expect(cfg.logging.level).toBe("info");
      expect(cfg.logging.json).toBe(false);
    });

    it("accepts full custom config", () => {
      const cfg = loadConfig({
        database: { path: "/tmp/test.db", wal: false },
        den: { coreUrl: "https://den.example.com:9999", requiredAtStartup: false },
        health: { port: 8000, host: "0.0.0.0" },
        logging: { level: "debug", json: true },
      });
      expect(cfg.database.path).toBe("/tmp/test.db");
      expect(cfg.database.wal).toBe(false);
      expect(cfg.den.coreUrl).toBe("https://den.example.com:9999");
      expect(cfg.den.requiredAtStartup).toBe(false);
      expect(cfg.health.port).toBe(8000);
      expect(cfg.health.host).toBe("0.0.0.0");
      expect(cfg.logging.level).toBe("debug");
      expect(cfg.logging.json).toBe(true);
    });

    it("accepts all valid log levels", () => {
      const levels = ["debug", "info", "warn", "error"] as const;
      for (const level of levels) {
        expect(() =>
          loadConfig({
            den: { coreUrl: "http://den-srv:3030" },
            logging: { level },
          }),
        ).not.toThrow();
      }
    });
  });

  describe("invalid input", () => {
    it("throws ConfigurationError for missing den.coreUrl", () => {
      expect(() => loadConfig({})).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError for invalid den.coreUrl", () => {
      expect(() =>
        loadConfig({ den: { coreUrl: "not-a-url" } }),
      ).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError for invalid log level", () => {
      expect(() =>
        loadConfig({
          den: { coreUrl: "http://den-srv:3030" },
          logging: { level: "verbose" },
        }),
      ).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError for port out of range", () => {
      expect(() =>
        loadConfig({
          den: { coreUrl: "http://den-srv:3030" },
          health: { port: 0 },
        }),
      ).toThrow(ConfigurationError);

      expect(() =>
        loadConfig({
          den: { coreUrl: "http://den-srv:3030" },
          health: { port: 99999 },
        }),
      ).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError for empty database path", () => {
      expect(() =>
        loadConfig({
          den: { coreUrl: "http://den-srv:3030" },
          database: { path: "" },
        }),
      ).toThrow(ConfigurationError);
    });

    it("error message lists all issues", () => {
      let message = "";
      try {
        loadConfig({ health: { port: 0 } });
      } catch (err) {
        message = (err as Error).message;
      }
      // Should mention both den and health.port issues
      expect(message).toContain("Invalid gateway configuration");
      expect(message).toContain("den");
      expect(message).toContain("health.port");
    });

    it("ConfigurationError is not retryable and has correct code", () => {
      try {
        loadConfig({});
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigurationError);
        const ce = err as ConfigurationError;
        expect(ce.code).toBe("CONFIGURATION_ERROR");
        expect(ce.retryable).toBe(false);
      }
    });
  });

  describe("unknown keys", () => {
    it("strips unknown top-level keys (zod strict not used here)", () => {
      // GatewayConfigSchema is z.object — extra keys pass through unless
      // we use .strict(). The config loader behaviour with extra keys is
      // that they are silently dropped by zod's parse.
      const cfg = loadConfig({
        den: { coreUrl: "http://den-srv:3030" },
        extraField: "should be ignored",
      });
      expect((cfg as Record<string, unknown>).extraField).toBeUndefined();
    });
  });
});
