import { describe, it, expect } from "vitest";
import {
  GatewayError,
  ConfigurationError,
  ConnectionError,
  SessionLimitError,
  ProviderError,
  TimeoutError,
  AuthenticationError,
} from "./errors.js";

describe("GatewayError", () => {
  it("is abstract and cannot be instantiated directly with required fields", () => {
    // GatewayError is abstract — concrete subclasses must set code/statusCode/retryable.
    // Verify that a concrete subclass satisfies the contract.
    class TestError extends GatewayError {
      public readonly code = "TEST";
      public readonly statusCode = 418;
      public readonly retryable = true;
      constructor(message: string) {
        super(message);
        this.name = "TestError";
      }
    }
    const err = new TestError("test message");
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("test message");
    expect(err.name).toBe("TestError");
    expect(err.code).toBe("TEST");
    expect(err.statusCode).toBe(418);
    expect(err.retryable).toBe(true);
  });
});

describe("ConfigurationError", () => {
  it("exposes code, statusCode, and retryable", () => {
    const err = new ConfigurationError("bad config");
    expect(err.code).toBe("CONFIGURATION_ERROR");
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("bad config");
    expect(err.name).toBe("ConfigurationError");
  });
});

describe("ConnectionError", () => {
  it("exposes code, statusCode, and retryable", () => {
    const err = new ConnectionError("unreachable");
    expect(err.code).toBe("CONNECTION_ERROR");
    expect(err.statusCode).toBe(502);
    expect(err.retryable).toBe(true);
  });
});

describe("SessionLimitError", () => {
  it("exposes code, statusCode, and retryable", () => {
    const err = new SessionLimitError("pool full");
    expect(err.code).toBe("SESSION_LIMIT_ERROR");
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });
});

describe("ProviderError", () => {
  it("exposes code, statusCode, and retryable", () => {
    const err = new ProviderError("rate limited");
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.statusCode).toBe(502);
    expect(err.retryable).toBe(true);
  });
});

describe("TimeoutError", () => {
  it("exposes code, statusCode, and retryable", () => {
    const err = new TimeoutError("deadline exceeded");
    expect(err.code).toBe("TIMEOUT_ERROR");
    expect(err.statusCode).toBe(504);
    expect(err.retryable).toBe(true);
  });
});

describe("AuthenticationError", () => {
  it("exposes code, statusCode, and retryable", () => {
    const err = new AuthenticationError("invalid token");
    expect(err.code).toBe("AUTHENTICATION_ERROR");
    expect(err.statusCode).toBe(401);
    expect(err.retryable).toBe(false);
  });
});
